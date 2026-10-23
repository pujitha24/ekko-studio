import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerTurn } from '../../packages/server/src/modules/coding-agents/services/codex/app-server-turn'

// A real stdio process, with no model access and no command execution.
const fixture = String.raw`
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: {} })
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread' } } })
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } })
    send({ id: 'approval-rpc', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread', turnId: 'turn', itemId: 'command', command: 'echo fixture' } })
  }
  if (message.id === 'approval-rpc' && message.result) {
    send({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread', turnId: 'turn', delta: 'decision=' + message.result.decision } })
    send({ method: 'turn/completed', params: {
      threadId: 'thread', turn: { id: 'turn', status: 'completed' } } })
  }
})
`

describe('Codex app-server real stdio lifecycle', () => {
  it.each(['once', 'session', 'deny'])('waits for the Studio %s response before completing', async choice => {
    const child = spawn(process.execPath, ['-e', fixture], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const closed = once(child, 'close')
    const callbacks = {
      session: vi.fn(), event: vi.fn(), approval: vi.fn(), approvalResolved: vi.fn(),
      failed: vi.fn(), activity: vi.fn(), inputClosed: vi.fn(),
    }
    const turn = new CodexAppServerTurn(child, callbacks)
    try {
      await turn.start({ cwd: process.cwd(), text: 'test', images: [] })
      await vi.waitFor(() => expect(callbacks.approval).toHaveBeenCalledOnce())
      expect(turn.completed).toBe(false)
      expect(callbacks.event).not.toHaveBeenCalled()
      const id = callbacks.approval.mock.calls[0]![0].id
      expect(turn.resolveApproval(id, choice)).toEqual({ handled: true, resolved: true })
      const [code] = await closed
      expect(code).toBe(0)
      expect(turn.completed).toBe(true)
      expect(callbacks.failed).not.toHaveBeenCalled()
      expect(callbacks.event).toHaveBeenCalledWith('item/agentMessage/delta',
        expect.objectContaining({ delta: `decision=${choice === 'session' ? 'acceptForSession' : choice === 'once' ? 'accept' : 'decline'}` }))
    } finally {
      turn.dispose()
      if (child.exitCode === null) child.kill()
    }
  }, 15_000)
})
