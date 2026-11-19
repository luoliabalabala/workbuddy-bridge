import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fixture } from './fixtures.mjs'
import { createBridge } from '../index.js'
const root = fileURLToPath(new URL('..', import.meta.url))
function child(script, args, input, env = {}) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { input, encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, ...env } })
}
test('stdio handshake, discovery, invalid arguments and RPC errors use JSON only', () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workbuddy_run', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'unknown' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n{bad json}\n'
  const result = child('bin/mcp.mjs', [], input)
  assert.equal(result.status, 0, result.stderr)
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 5)
  assert.equal(rows.find(row => row.id === 1).result.protocolVersion, '2025-06-18')
  assert.equal(rows.find(row => row.id === 2).result.tools.length, 10)
  assert.equal(rows.find(row => row.id === 3).result.structuredContent.code, 'INVALID_ARGUMENT')
  assert.equal(rows.find(row => row.id === 3).result.isError, true)
  assert.equal(rows.find(row => row.id === 4).error.code, -32601)
  assert.ok(rows.some(row => row.error?.code === -32700))
})
test('CLI lists tools and rejects malformed or incomplete invocations', () => {
  assert.equal(JSON.parse(child('bin/cli.mjs', ['tools']).stdout).length, 10)
  const result = child('bin/cli.mjs', ['call', 'workbuddy_send', '{"task":"hello"}'])
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, 'INVALID_ARGUMENT')
})
test('a failed synthetic DB read is returned as a tool error without launching UI', async t => {
  const f = fixture(t)
  const bridge = createBridge({ dbPath: path.join(f.root, 'missing.db'), lockPath: f.lockPath })
  const response = await bridge.callTool('workbuddy_sessions', {})
  assert.equal(response.ok, false); assert.equal(response.code, 'DB_UNAVAILABLE')
  assert.equal(fs.existsSync(f.lockPath), false)
})
test('unsafe stateful calls and accidental copies fail before taking a lock', async t => {
  const f = fixture(t); const bridge = createBridge({ dbPath: f.dbPath, lockPath: f.lockPath })
  for (const [name, args] of [['workbuddy_run', { task: '' }], ['workbuddy_send', { task: 'x' }], ['workbuddy_collect', { sessionId: 'a', mode: 'copy' }], ['workbuddy_status', { restart: true, launch: false }], ['workbuddy_sessions', { limit: -1 }]]) {
    assert.equal((await bridge.callTool(name, args)).code, 'INVALID_ARGUMENT')
  }
  assert.equal(fs.existsSync(f.lockPath), false)
})
test('portable and compatibility manifests point at the same bundled local server', () => {
  const portable = JSON.parse(fs.readFileSync(path.join(root, 'mcp.json')))
  const compat = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json')))
  assert.deepEqual(portable.mcpServers, compat.mcpServers)
  const entry = portable.mcpServers.workbuddy_bridge
  const resolved = entry.args[0].replace('${PLUGIN_ROOT}', root)
  const result = spawnSync(process.execPath, [resolved], { cwd: entry.cwd.replace('${PLUGIN_ROOT}', root), input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n', encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout).result, {})
  assert.ok(fs.existsSync(path.join(root, 'lib/db-read.mjs')))
})
