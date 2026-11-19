import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createTicket } from '../lib/dispatch.js'
import { readWatch } from '../lib/watch.js'
import { fixture, user, assistant } from './fixtures.mjs'

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))
const mcp = fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))

async function until(check, label) {
  const deadline = Date.now() + 9000
  do {
    if (check()) return
    await delay(60)
  } while (Date.now() < deadline)
  assert.fail(label)
}

test('monitor outlives its MCP worker and host, captures the correct turn, exits and serves a new call', async t => {
  const f = fixture(t)
  const config = path.join(f.root, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ ...f.options, lockPath: f.lockPath }))
  const spawnOptions = {
    encoding: 'utf8', windowsHide: true, timeout: 7000,
    env: { ...process.env, WORKBUDDY_BRIDGE_CONFIG: config, WORKBUDDY_BRIDGE_WARM_SECONDS: '60' },
  }
  const task = 'background test'
  const baselineBytes = f.log('watch-session', [user('older'), assistant('older reply')])
  const ticket = createTicket(f.options, { task, sessionId: 'watch-session', baselineBytes, baselineActivityAt: 1000 })
  f.row('watch-session', { status: 'working', updated_at: Date.now() })
  f.log('watch-session', [user(task)], true)
  const options = { dispatchId: ticket.dispatchId, timeoutSec: 12 }
  const callMcp = args => {
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workbuddy_watch', arguments: args } }
    const response = spawnSync(process.execPath, [mcp], { ...spawnOptions, input: JSON.stringify(request) + '\n' })
    assert.equal(response.status, 0, response.stdout || response.stderr || String(response.error))
    return JSON.parse(response.stdout).result.structuredContent
  }
  const launch = () => {
    const started = spawnSync(process.execPath, [cli, 'call', 'workbuddy_watch', JSON.stringify(options)], spawnOptions)
    assert.equal(started.status, 0, started.stdout || started.stderr || String(started.error))
    return JSON.parse(started.stdout)
  }
  const state = callMcp(options)
  assert.equal(state.status, 'monitoring')
  assert.equal(launch().pid, state.pid)
  process.kill(state.pid, 0)

  f.log('watch-session', [assistant('saved final reply')], true)
  f.row('watch-session', { status: 'completed', updated_at: Date.now(), last_activity_at: Date.now() })
  await until(() => readWatch(f.options, ticket.dispatchId)?.done, 'monitor did not persist a result after MCP exit')
  await until(() => {
    try { process.kill(state.pid, 0); return false }
    catch (error) { if (error.code === 'ESRCH') return true; throw error }
  }, 'monitor did not exit after saving the result')

  f.log('watch-session', [user('another round'), assistant('different reply')], true)
  const reply = callMcp({ dispatchId: ticket.dispatchId, action: 'result' })
  assert.equal(reply.result.answer, 'saved final reply')
  assert.equal(reply.status, 'completed')
})
