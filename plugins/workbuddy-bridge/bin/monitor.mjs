import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dispatchFolder, loadTicket } from '../lib/dispatch.js'
import { withLock } from '../lib/lock.js'
import { readWatch, writeWatch } from '../lib/watch.js'

async function acknowledge(message) {
  if (!process.connected) return
  await new Promise(resolve => process.send(message, resolve))
  if (process.connected) process.disconnect()
}

process.once('message', async ({ options, args: { dispatchId, timeoutSec } }) => {
  let acknowledged = false
  try {
    loadTicket(options, dispatchId)
    await withLock(path.join(dispatchFolder(options), `watch-${dispatchId}.lock`), async () => {
      const prior = readWatch(options, dispatchId)
      if (prior?.done) {
        await acknowledge({ state: prior })
        return
      }
      const startedAt = Date.now()
      const deadline = startedAt + timeoutSec * 1000
      const state = { dispatchId, status: 'monitoring', done: false, pid: process.pid, startedAt, deadline }
      writeWatch(options, state)
      await acknowledge({ state })
      acknowledged = true

      try {
        const { waitForRun, collect } = await import('../lib/flow.js')
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now()
          const waited = await waitForRun(options, { dispatchId, timeoutSec: Math.min(15, remaining / 1000) }, { readOnly: true, intervalMs: 2500 })
          if (waited.done) {
            const collected = waited.status === 'completed'
              ? await collect(options, { sessionId: waited.sessionId, since: loadTicket(options, dispatchId).since, answer: waited.turn.answer })
              : undefined
            const result = { ok: waited.status === 'completed', status: waited.status, sessionId: waited.sessionId, answer: collected?.answer, files: collected?.files }
            writeWatch(options, { ...state, finishedAt: Date.now(), done: true, status: waited.status, sessionId: waited.sessionId, result })
            return
          }
          if (waited.needsRecovery) await delay(Math.max(0, Math.min(2500, deadline - Date.now())))
        }
        writeWatch(options, { ...state, finishedAt: Date.now(), status: 'monitor-timeout' })
      } catch (error) {
        writeWatch(options, { ...state, finishedAt: Date.now(), status: 'monitor-error', code: error.code ?? 'OBSERVATION_ERROR', text: error.message })
      }
    })
  } catch (error) {
    if (!acknowledged) {
      const state = error.code === 'BRIDGE_BUSY' ? readWatch(options, dispatchId) : undefined
      await acknowledge(state?.status === 'monitoring' ? { state } : { error: error.message, code: error.code ?? 'WATCH_START_FAILED' })
    }
  }
})
