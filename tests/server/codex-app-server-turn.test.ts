import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_APPROVAL_TIMEOUT_MS,
  CodexAppServerTurn,
  codexAppServerArgs,
} from '../../packages/server/src/modules/coding-agents/services/codex/app-server-turn'

function fixture(sessionApprovals?: Set<string>) {
  const writes: any[] = []
  const child = new EventEmitter() as ChildProcess
  child.stdout = new PassThrough()
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(JSON.parse(String(chunk)))
      callback()
    },
  })
  const callbacks = {
    session: vi.fn(), event: vi.fn(), approval: vi.fn(), approvalResolved: vi.fn(),
    failed: vi.fn(), activity: vi.fn(), inputClosed: vi.fn(),
  }
  const turn = new CodexAppServerTurn(child, callbacks, sessionApprovals)
  const send = (message: object) => (child.stdout as PassThrough).write(`${JSON.stringify(message)}\n`)
  const tick = async () => { await Promise.resolve(); await Promise.resolve() }
  const initialize = async (options: Record<string, unknown> = {}) => {
    const ready = turn.start({ cwd: '/workspace', text: 'hello 世界', images: [], ...options })
    expect(writes.at(-1).method).toBe('initialize')
    send({ id: 1, result: {} })
    await tick()
    return { ready, tick }
  }
  const start = async (options: Record<string, unknown> = {}, threadId = 'thread-1') => {
    const { ready, tick } = await initialize(options)
    send({ id: 2, result: { thread: { id: threadId } } })
    await tick()
    send({ id: 3, result: { turn: { id: 'turn-1' } } })
    await ready
  }
  const approval = (id: string | number = 99, overrides: Record<string, unknown> = {}, method = 'item/commandExecution/requestApproval') => send({
    id, method,
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'echo test', cwd: '/workspace', ...overrides },
  })
  return { child, turn, callbacks, writes, send, initialize, start, approval }
}

afterEach(() => { vi.useRealTimers() })

describe('Codex app-server chat transport', () => {
  it('starts an approval-capable thread and carries prompts and images over stdin', async () => {
    const f = fixture()
    await f.start({ model: 'custom-model', images: [{ path: '/截图.png' }], developerInstructions: 'system instructions' })
    expect(f.writes.find(message => message.method === 'thread/start').params).toEqual({
      cwd: '/workspace', model: 'custom-model', developerInstructions: 'system instructions',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'danger-full-access',
    })
    expect(f.writes.find(message => message.method === 'turn/start').params.input).toEqual([
      { type: 'text', text: 'hello 世界', text_elements: [] },
      { type: 'localImage', path: '/截图.png' },
    ])
    expect(f.callbacks.session).toHaveBeenCalledWith('thread-1')
    expect(f.child.stdin?.writable).toBe(true)
    f.turn.dispose()
  })

  it('resumes the exact native thread without replaying its historical items', async () => {
    const f = fixture()
    const { ready, tick } = await f.initialize({ nativeSessionId: 'saved-thread' })
    expect(f.writes.at(-1)).toMatchObject({ method: 'thread/resume', params: { threadId: 'saved-thread', approvalPolicy: 'on-request' } })
    f.send({ method: 'item/completed', params: { threadId: 'saved-thread', turnId: 'old', item: { text: 'old text' } } })
    f.send({ id: 2, result: { thread: { id: 'saved-thread', turns: [{ items: [{ text: 'old text' }] }] } } })
    await tick()
    f.send({ id: 3, result: { turn: { id: 'turn-1' } } })
    await ready
    expect(f.callbacks.event).not.toHaveBeenCalled()
    f.turn.dispose()
  })

  it.each(['once', 'session', 'deny'])('resolves a command approval exactly once for choice %s', async choice => {
    const f = fixture()
    await f.start()
    f.approval('request-99')
    const request = f.callbacks.approval.mock.calls[0]![0]
    expect(request).toMatchObject({
      command: 'echo test', description: '/workspace', choices: ['once', 'session', 'deny'],
      timeoutMs: CODEX_APPROVAL_TIMEOUT_MS,
    })
    expect(f.writes.some(message => message.id === 'request-99')).toBe(false)
    expect(f.turn.resolveApproval(request.id, 'always')).toEqual({ handled: true, resolved: false })
    expect(f.turn.resolveApproval(request.id, choice)).toEqual({ handled: true, resolved: true })
    expect(f.writes.at(-1)).toMatchObject({
      id: 'request-99',
      result: { decision: choice === 'session' ? 'acceptForSession' : choice === 'once' ? 'accept' : 'decline' },
    })
    expect(f.turn.resolveApproval(request.id, choice)).toEqual({ handled: false, resolved: false })
    f.turn.dispose()
  })

  it('persists only the exact user-approved command context across turns of one managed session', async () => {
    const grants = new Set<string>()
    const first = fixture(grants)
    await first.start()
    first.approval()
    const id = first.callbacks.approval.mock.calls[0]![0].id
    expect(first.turn.resolveApproval(id, 'session').resolved).toBe(true)
    first.turn.dispose()

    const resumed = fixture(grants)
    await resumed.start({ nativeSessionId: 'thread-1' })
    resumed.approval()
    expect(resumed.callbacks.approval).not.toHaveBeenCalled()
    expect(resumed.writes.at(-1)).toMatchObject({ id: 99, result: { decision: 'acceptForSession' } })
    resumed.approval(100, { command: 'echo different' })
    resumed.approval(101, { cwd: '/different-directory' })
    resumed.approval(102, { environmentId: 'remote-device' })
    resumed.approval(103, { reason: 'new reason' })
    resumed.approval(104, { kind: 'stdin' })
    expect(resumed.callbacks.approval).toHaveBeenCalledTimes(5)
    resumed.turn.dispose()

    const otherThread = fixture(grants)
    await otherThread.start({}, 'another-thread')
    otherThread.approval(99, { threadId: 'another-thread' })
    expect(otherThread.callbacks.approval).toHaveBeenCalledOnce()
    otherThread.turn.dispose()

    const otherSession = fixture()
    await otherSession.start()
    otherSession.approval()
    expect(otherSession.callbacks.approval).toHaveBeenCalledOnce()
    otherSession.turn.dispose()
  })

  it.each(['once', 'deny'])('does not retain a session grant for %s', async choice => {
    const grants = new Set<string>()
    const f = fixture(grants)
    await f.start()
    f.approval()
    f.turn.resolveApproval(f.callbacks.approval.mock.calls[0]![0].id, choice)
    expect(grants.size).toBe(0)
    f.turn.dispose()
  })

  it('offers persistent approval only for the native-proposed rule and sends it unchanged', async () => {
    const f = fixture()
    await f.start()
    const rule = ['echo', 'test']
    f.approval(99, { proposedExecpolicyAmendment: rule })
    const request = f.callbacks.approval.mock.calls[0]![0]
    expect(request).toMatchObject({
      command: 'echo test', choices: ['once', 'session', 'always', 'deny'], execpolicyAmendment: rule,
    })
    expect(f.turn.resolveApproval(request.id, 'always').resolved).toBe(true)
    expect(f.writes.at(-1)).toMatchObject({
      id: 99, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rule } } },
    })
    f.turn.dispose()
  })

  it('does not offer persistent permission for missing/malformed proposals or file changes', async () => {
    const f = fixture()
    await f.start()
    for (const [index, value] of [null, [], [''], [1], 'echo'].entries()) {
      f.approval(index + 80, { proposedExecpolicyAmendment: value })
      const request = f.callbacks.approval.mock.calls.at(-1)![0]
      expect(request.choices).not.toContain('always')
      expect(f.turn.resolveApproval(request.id, 'always')).toEqual({ handled: true, resolved: false })
    }
    f.approval(99, { proposedExecpolicyAmendment: ['echo'] }, 'item/fileChange/requestApproval')
    expect(f.callbacks.approval.mock.calls.at(-1)![0].choices).toEqual(['once', 'session', 'deny'])
    f.turn.dispose()
  })

  it('handles independent callbacks for the same item and file-change approvals', async () => {
    const f = fixture()
    await f.start()
    f.approval(80)
    f.approval(81)
    f.approval(82, { grantRoot: '/workspace/output' }, 'item/fileChange/requestApproval')
    const ids = f.callbacks.approval.mock.calls.map(([request]) => request.id)
    expect(new Set(ids).size).toBe(3)
    expect(f.turn.resolveApproval(ids[2]!, 'deny').resolved).toBe(true)
    expect(f.writes.at(-1)).toMatchObject({ id: 82, result: { decision: 'decline' } })
    f.turn.dispose()
    expect(f.callbacks.approvalResolved).toHaveBeenCalledTimes(2)
  })

  it('rejects stale or unrelated approval requests and unsupported client methods', async () => {
    const f = fixture()
    await f.start()
    f.approval(80, { threadId: 'other-thread' })
    f.approval(81, { turnId: 'old-turn' })
    f.approval(82, {}, 'item/tool/call')
    expect(f.callbacks.approval).not.toHaveBeenCalled()
    expect(f.writes.slice(-3)).toMatchObject([
      { id: 80, result: { decision: 'decline' } },
      { id: 81, result: { decision: 'decline' } },
      { id: 82, error: { code: -32601 } },
    ])
    f.turn.dispose()
  })

  it('validates approvals arriving before the turn/start response against the returned turn', async () => {
    const f = fixture()
    const { ready, tick } = await f.initialize()
    f.send({ id: 2, result: { thread: { id: 'thread-1' } } })
    await tick()
    f.approval(80, { turnId: 'old-turn' })
    f.approval(81)
    expect(f.callbacks.approval).not.toHaveBeenCalled()
    f.send({ id: 3, result: { turn: { id: 'turn-1' } } })
    await ready
    expect(f.callbacks.approval).toHaveBeenCalledOnce()
    expect(f.writes).toContainEqual({ jsonrpc: '2.0', id: 80, result: { decision: 'decline' } })
    f.turn.dispose()
  })

  it('declines and clears an approval on timeout rather than approving it', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.start()
    f.approval()
    const id = f.callbacks.approval.mock.calls[0]![0].id
    await vi.advanceTimersByTimeAsync(CODEX_APPROVAL_TIMEOUT_MS)
    expect(f.writes.at(-1)).toMatchObject({ id: 99, result: { decision: 'decline' } })
    expect(f.callbacks.approvalResolved).toHaveBeenCalledWith(id, 'Codex approval expired')
    expect(f.turn.resolveApproval(id, 'once').handled).toBe(false)
    f.turn.dispose()
  })

  it('does not treat an RPC acknowledgement or foreign completion as success', async () => {
    const f = fixture()
    await f.start()
    expect(f.turn.completed).toBe(false)
    f.send({ method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn-1', status: 'completed' } } })
    expect(f.turn.completed).toBe(false)
    f.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'provider failed' } } } })
    expect(f.callbacks.failed).toHaveBeenCalledWith('provider failed')
    expect(f.turn.completed).toBe(false)
  })

  it('preserves UTF-8 split across frames and closes stdin only after a terminal turn event', async () => {
    const f = fixture()
    await f.start()
    const frame = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: '中文' } }) + '\n')
    const split = frame.indexOf(Buffer.from('中')) + 1
    ;(f.child.stdout as PassThrough).write(frame.subarray(0, split))
    ;(f.child.stdout as PassThrough).write(frame.subarray(split))
    expect(f.callbacks.event).toHaveBeenCalledWith('item/agentMessage/delta', expect.objectContaining({ delta: '中文' }))
    f.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    expect(f.turn.completed).toBe(true)
    expect(f.child.stdin?.writableEnded).toBe(true)
    f.child.emit('close', 0)
    expect(f.callbacks.failed).not.toHaveBeenCalled()
  })

  it('fails on an early process close and clears pending approvals', async () => {
    const f = fixture()
    await f.start()
    f.approval()
    const id = f.callbacks.approval.mock.calls[0]![0].id
    f.child.emit('close', 0)
    expect(f.callbacks.failed).toHaveBeenCalledWith('Codex app-server closed before the turn completed')
    expect(f.callbacks.approvalResolved).toHaveBeenCalledWith(id, 'Codex connection closed')
    expect(f.turn.resolveApproval(id, 'once').handled).toBe(false)
  })

  it('reports initialization errors and timeouts without falling back to exec', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const ready = f.turn.start({ cwd: '/workspace', text: 'hello', images: [] })
    await vi.advanceTimersByTimeAsync(30_000)
    await ready
    expect(f.callbacks.failed).toHaveBeenCalledWith('Codex app-server initialize timed out')
    expect(f.writes.map(message => message.method)).toEqual(['initialize'])
  })

  it('converts model CLI flags to app-server config without adding exec or bypass flags', () => {
    expect(codexAppServerArgs(['--model', 'custom', '-c', 'model_reasoning_effort="high"'])).toEqual([
      'app-server', '--stdio', '-c', 'model="custom"', '-c', 'model_reasoning_effort="high"',
    ])
  })
})
