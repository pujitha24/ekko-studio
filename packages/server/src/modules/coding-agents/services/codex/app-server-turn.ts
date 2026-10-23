import { parseMcpForm } from './interaction'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { CodingAgentImageInput } from '../../protocol/types'

const REQUEST_TIMEOUT_MS = 30_000
export const CODEX_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_FRAME_CHARS = 16 * 1024 * 1024

interface PendingRequest {
  resolve(value: any): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface PendingApproval {
  rpcId: string | number
  timer: ReturnType<typeof setTimeout>
  choices: string[]
  result?: (choice: string) => object
  sessionKey?: string
  execpolicyAmendment?: string[]
}

interface Callbacks {
  clarification?(request: { id: string; question: string; choices: string[] | null; timeoutMs: number }): void
  clarificationResolved?(id: string, reason: string): void
  session(id: string): void
  event(method: string, params: any): void
  approval(request: {
    id: string
    command: string
    description: string
    choices: string[]
    execpolicyAmendment?: string[]
    timeoutMs: number
  }): void
  approvalResolved(id: string, reason: string): void
  failed(message: string): void
  inputClosed(): void
  activity(): void
}

/** One foreground turn over Codex's stdio JSON-RPC transport. */
export class CodexAppServerTurn {
  private sequence = 0
  private pending = new Map<number, PendingRequest>()
  private approvals = new Map<string, PendingApproval>()
  private interactions = new Map<string, { rpcId: string | number; timer: ReturnType<typeof setTimeout>; respond: (value: string) => object; cancel: object }>()
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private closed = false
  private threadId = ''
  private turnId = ''
  private startingTurn = false
  private earlyEvents: any[] = []
  completed = false

  constructor(
    private child: ChildProcess,
    private callbacks: Callbacks,
    private sessionApprovals = new Set<string>(),
  ) {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.closed) return
      this.callbacks.activity()
      try {
        this.buffer += this.decoder.write(chunk)
        let end: number
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end).trim()
          this.buffer = this.buffer.slice(end + 1)
          if (line.length > MAX_FRAME_CHARS) throw new Error('Codex app-server frame exceeds 16 MiB')
          if (line.startsWith('{')) this.receive(JSON.parse(line))
        }
        if (this.buffer.length > MAX_FRAME_CHARS) throw new Error('Codex app-server frame exceeds 16 MiB')
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stdin?.on('error', error => this.fail(error))
    child.on('error', error => this.fail(error))
    child.on('close', () => {
      if (!this.completed && !this.closed) this.fail(new Error('Codex app-server closed before the turn completed'))
      else this.dispose()
    })
  }

  private write(message: object) {
    if (this.closed || !this.child.stdin?.writable) throw new Error('Codex app-server connection is closed')
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  private request(method: string, params: object): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async start(input: {
    cwd: string
    text: string
    images: CodingAgentImageInput[]
    nativeSessionId?: string
    model?: string
    developerInstructions?: string
  }): Promise<void> {
    try {
      await this.request('initialize', {
        clientInfo: { name: 'ekko_studio', version: '1.0.0' },
        capabilities: null,
      })
      this.write({ method: 'initialized' })
      const thread = await this.request(input.nativeSessionId ? 'thread/resume' : 'thread/start', {
        ...(input.nativeSessionId ? { threadId: input.nativeSessionId } : {}),
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
        // Never means "reject dangerous commands without asking", even with no sandbox.
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
      })
      this.threadId = String(thread?.thread?.id || '')
      if (!this.threadId) throw new Error('Codex app-server returned no thread ID')
      this.callbacks.session(this.threadId)
      this.startingTurn = true
      const turn = await this.request('turn/start', {
        threadId: this.threadId,
        input: [
          ...(input.text ? [{ type: 'text', text: input.text, text_elements: [] }] : []),
          ...input.images.map(image => ({ type: 'localImage', path: image.path })),
        ],
      })
      this.turnId = String(turn?.turn?.id || '')
      if (!this.turnId) throw new Error('Codex app-server returned no turn ID')
      this.startingTurn = false
      for (const event of this.earlyEvents.splice(0)) this.receive(event)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private receive(message: any) {
    if (!message || typeof message !== 'object' || this.closed) return
    if (message.method) {
      if (this.startingTurn) {
        if (this.earlyEvents.length >= 10_000) throw new Error('Too many Codex notifications before turn/start')
        this.earlyEvents.push(message)
      } else if (message.id !== undefined) {
        this.serverRequest(message)
      } else {
        this.notification(message.method, message.params || {})
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`Codex app-server: ${message.error.message || 'request failed'}`))
    else pending.resolve(message.result)
  }

  private serverRequest(message: any) {
    const params = message.params || {}
    if (this.interactionRequest(message)) return
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported Codex client method' } })
      return
    }
    // A saved thread may replay events; approvals must belong to this foreground turn.
    if (!this.threadId || params.threadId !== this.threadId
      || (!this.turnId && !this.startingTurn) || (this.turnId && params.turnId !== this.turnId)
      || this.completed) {
      this.write({ id: message.id, result: { decision: 'decline' } })
      return
    }
    if ([...this.approvals.values(), ...this.interactions.values()].some(request => request.rpcId === message.id)) return
    const sessionKey = this.commandSessionKey(message.method, params)
    if (sessionKey && this.sessionApprovals.has(sessionKey)) {
      this.write({ id: message.id, result: { decision: 'acceptForSession' } })
      return
    }
    const proposed = params.proposedExecpolicyAmendment
    const execpolicyAmendment = message.method === 'item/commandExecution/requestApproval'
      && Array.isArray(proposed) && proposed.length > 0
      && proposed.every(value => typeof value === 'string' && value.trim().length > 0)
      ? [...proposed] as string[] : undefined
    const choices = ['once', 'session', ...(execpolicyAmendment ? ['always'] : []), 'deny']
    const id = `codex_${randomUUID()}`
    const timer = setTimeout(() => {
      if (this.resolveApproval(id, 'deny').resolved) this.callbacks.approvalResolved(id, 'Codex approval expired')
    }, CODEX_APPROVAL_TIMEOUT_MS)
    timer.unref?.()
    this.approvals.set(id, { rpcId: message.id, timer, choices, sessionKey, execpolicyAmendment })
    this.callbacks.approval({
      id,
      command: typeof params.command === 'string' ? params.command : '',
      description: [params.reason, params.cwd, params.grantRoot].filter(value => typeof value === 'string' && value.trim()).join('\n'),
      choices,
      ...(execpolicyAmendment ? { execpolicyAmendment } : {}),
      timeoutMs: CODEX_APPROVAL_TIMEOUT_MS,
    })
  }

  private interactionRequest(message: any): boolean {
    const method = message.method
    if (!['mcpServer/elicitation/request', 'item/tool/requestUserInput', 'tool/requestUserInput', 'item/permissions/requestApproval'].includes(method)) return false
    const p = message.params || {}
    const isMcp = method === 'mcpServer/elicitation/request'
    const permission = method === 'item/permissions/requestApproval'
    const cancel = isMcp ? { action: 'cancel', content: null } : permission ? { permissions: {}, scope: 'turn' } : { answers: {} }
    if (!this.threadId || p.threadId !== this.threadId || !this.turnId || this.completed
      || (p.turnId ? p.turnId !== this.turnId : !isMcp)) {
      this.write({ id: message.id, result: cancel }); return true
    }
    if ([...this.interactions.values(), ...this.approvals.values()].some(request => request.rpcId === message.id)) return true
    // Studio currently renders one clarification and one approval per session.
    // Do not replace a pending prompt and strand its native RPC.
    if (this.interactions.size || this.approvals.size) {
      this.write({ id: message.id, result: cancel }); return true
    }
    if (isMcp && !['form', 'url'].includes(p.mode)) {
      this.write({ id: message.id, result: cancel }); return true
    }
    if (permission || (isMcp && p.mode === 'url')) {
      // Display the URL as text; never navigate or perform an OAuth flow automatically.
      if (isMcp && (typeof p.url !== 'string' || !/^https?:\/\//i.test(p.url))) {
        this.write({ id: message.id, result: cancel }); return true
      }
      const id = `codex_${randomUUID()}`
      const result = (choice: string) => isMcp
        ? { action: choice === 'once' ? 'accept' : 'decline', content: null }
        : { permissions: choice === 'once' ? p.permissions || {} : {}, scope: 'turn' }
      const timer = setTimeout(() => {
        if (this.resolveApproval(id, 'deny').resolved) this.callbacks.approvalResolved(id, 'Codex approval expired')
      }, CODEX_APPROVAL_TIMEOUT_MS)
      timer.unref?.()
      this.approvals.set(id, { rpcId: message.id, timer, choices: ['once', 'deny'], result })
      this.callbacks.approval({ id, command: '', description: isMcp
        ? `${p.serverName}: ${p.message || ''}\n${p.url}`
        : `${p.reason || 'Codex permission request'}\n${JSON.stringify(p.permissions || {})}`,
        choices: ['once', 'deny'], timeoutMs: CODEX_APPROVAL_TIMEOUT_MS })
      return true
    }
    if (!this.callbacks.clarification) { this.write({ id: message.id, result: cancel }); return true }
    const id = `codex_input_${randomUUID()}`
    let question: string
    let choices: string[] | null = null
    let respond: (value: string) => object
    if (isMcp) {
      question = `${p.serverName}: ${p.message || ''}\nJSON schema: ${JSON.stringify(p.requestedSchema)}`
      respond = value => ({ action: 'accept', content: parseMcpForm(p.requestedSchema, value) })
    } else {
      const questions = p.questions
      if (!Array.isArray(questions) || !questions.length || questions.some(q => !q || typeof q.id !== 'string' || typeof q.question !== 'string' || q.isSecret)
        || new Set(questions.map(q => q.id)).size !== questions.length) {
        this.write({ id: message.id, result: cancel }); return true
      }
      const single = questions.length === 1
      question = questions.map(q => `${q.id}: ${q.question}\n${(q.options || []).map((o: any) => `${o.label}: ${o.description}`).join('\n')}`).join('\n\n')
      if (!single) question += '\nRespond as JSON: {"questionId":["answer"]}'
      if (single && !questions[0].isOther && Array.isArray(questions[0].options)) choices = questions[0].options.map((o: any) => String(o.label))
      respond = value => {
        const values = single ? { [questions[0].id]: [value] } : JSON.parse(value)
        const answers: Record<string, { answers: string[] }> = Object.create(null)
        if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length !== questions.length) throw new Error('Invalid answers')
        for (const q of questions) {
          const answer = values[q.id]
          if (!Array.isArray(answer) || answer.length !== 1 || typeof answer[0] !== 'string' || !answer[0].trim()) throw new Error('Missing answer')
          if (!q.isOther && q.options?.length && !q.options.some((o: any) => o.label === answer[0])) throw new Error('Invalid choice')
          answers[q.id] = { answers: answer }
        }
        return { answers }
      }
    }
    const timer = setTimeout(() => {
      if (this.resolveClarification(id, '').resolved) this.callbacks.clarificationResolved?.(id, 'Codex input expired')
    }, CODEX_APPROVAL_TIMEOUT_MS)
    timer.unref?.()
    this.interactions.set(id, { rpcId: message.id, timer, respond, cancel })
    this.callbacks.clarification({ id, question, choices, timeoutMs: CODEX_APPROVAL_TIMEOUT_MS })
    return true
  }

  resolveClarification(id: string, value: string): { handled: boolean; resolved: boolean } {
    const request = this.interactions.get(id)
    if (!request) return { handled: false, resolved: false }
    try {
      if (value.length > 20_000) return { handled: true, resolved: false }
      this.write({ id: request.rpcId, result: value ? request.respond(value) : request.cancel })
    } catch { return { handled: true, resolved: false } }
    clearTimeout(request.timer)
    this.interactions.delete(id)
    this.callbacks.activity()
    return { handled: true, resolved: true }
  }

  private commandSessionKey(method: string, params: any): string | undefined {
    // The CLI process is disposable between turns. Reapply an explicit session
    // grant only for the identical command, directory and native thread/context.
    // Network and stdin grants have different scopes and remain native-only.
    if (method !== 'item/commandExecution/requestApproval'
      || (params.kind && params.kind !== 'command') || params.networkApprovalContext
      || typeof params.command !== 'string' || !params.command.trim()
      || typeof params.cwd !== 'string' || !params.cwd.trim()) return undefined
    return createHash('sha256').update(JSON.stringify([
      this.threadId, params.command, params.cwd,
      params.environmentId ?? null, params.reason ?? null,
    ])).digest('hex')
  }

  resolveApproval(id: string, choice: string): { handled: boolean; resolved: boolean } {
    const request = this.approvals.get(id)
    if (!request) return { handled: false, resolved: false }
    if (!request.choices.includes(choice)) return { handled: true, resolved: false }
    const decision = choice === 'always'
      ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: request.execpolicyAmendment } }
      : choice === 'session' ? 'acceptForSession' : choice === 'once' ? 'accept' : 'decline'
    try {
      this.write({ id: request.rpcId, result: request.result ? request.result(choice) : { decision } })
    } catch {
      return { handled: true, resolved: false }
    }
    clearTimeout(request.timer)
    this.approvals.delete(id)
    if (choice === 'session' && request.sessionKey) {
      if (this.sessionApprovals.size >= 256) this.sessionApprovals.delete(this.sessionApprovals.values().next().value!)
      this.sessionApprovals.add(request.sessionKey)
    }
    this.callbacks.activity()
    return { handled: true, resolved: true }
  }

  private notification(method: string, params: any) {
    if (!this.threadId || params.threadId !== this.threadId) return
    const turnId = params.turnId || params.turn?.id
    if (!this.turnId || (turnId && turnId !== this.turnId) || this.completed) return
    if (method === 'serverRequest/resolved') {
      for (const [id, request] of this.interactions) {
        if (request.rpcId === params.requestId) { clearTimeout(request.timer); this.interactions.delete(id); this.callbacks.clarificationResolved?.(id, 'Codex request resolved') }
      }
      for (const [id, request] of this.approvals) {
        if (request.rpcId === params.requestId) { clearTimeout(request.timer); this.approvals.delete(id); this.callbacks.approvalResolved(id, 'Codex request resolved') }
      }
      return
    }
    if (method === 'turn/completed') {
      this.clearApprovals('Codex turn completed')
      if (params.turn?.status !== 'completed') {
        this.fail(new Error(params.turn?.error?.message || `Codex turn ${params.turn?.status || 'failed'}`))
        return
      }
      this.completed = true
      this.child.stdin?.end()
      this.callbacks.inputClosed()
      return
    }
    this.callbacks.event(method, params)
  }

  private clearApprovals(reason: string) {
    for (const [id, request] of this.interactions) {
      clearTimeout(request.timer)
      if (!this.closed) { try { this.write({ id: request.rpcId, result: request.cancel }) } catch {} }
      this.callbacks.clarificationResolved?.(id, reason)
    }
    this.interactions.clear()
    for (const [id, request] of this.approvals) {
      clearTimeout(request.timer)
      if (!this.closed) {
        try { this.write({ id: request.rpcId, result: request.result ? request.result('deny') : { decision: 'decline' } }) } catch {}
      }
      this.callbacks.approvalResolved(id, reason)
    }
    this.approvals.clear()
  }

  private fail(error: Error) {
    if (this.closed) return
    this.callbacks.failed(error.message)
    this.dispose()
    this.child.stdin?.end()
    this.callbacks.inputClosed()
  }

  dispose() {
    if (this.closed) return
    this.clearApprovals('Codex connection closed')
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server connection closed'))
    }
    this.pending.clear()
    this.earlyEvents = []
  }
}

/** CLI model selection belongs to thread/start; app-server only accepts config flags. */
export function codexAppServerArgs(args: string[]): string[] {
  const result = ['app-server', '--stdio']
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--model' || arg === '-m') {
      result.push('-c', `model=${JSON.stringify(args[++index] || '')}`)
    } else {
      result.push(arg)
    }
  }
  return result
}
