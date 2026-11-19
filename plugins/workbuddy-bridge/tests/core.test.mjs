import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixture, user, assistant } from './fixtures.mjs'
import * as flow from '../lib/flow.js'
import * as store from '../lib/store.js'
import { withLock } from '../lib/lock.js'

test('SQLite reads work without optional usage tables and do not write sessions', async t => {
  const f = fixture(t)
  f.row('a', { status: 'active', last_activity_at: 1 })
  f.row('b')
  const response = await store.listSessions({ dbPath: f.dbPath })
  assert.equal(response.ok, true)
  assert.equal(response.rows.length, 2)
  assert.equal((await store.activeSessions({ dbPath: f.dbPath })).rows[0].id, 'a')
  assert.equal(f.db.prepare('select count(*) n from sessions').get().n, 2)
})
test('ambiguous history lookup fails and exact id still resolves', async t => {
  const f = fixture(t)
  f.row('ab1', { title: 'duplicate' }); f.row('ab2', { title: 'duplicate' })
  await assert.rejects(flow.resolveSession(f.options, 'ab'), { code: 'AMBIGUOUS_SESSION' })
  assert.equal((await flow.resolveSession(f.options, 'ab1')).id, 'ab1')
})
test('new sessions are adopted by exact task evidence, never just newest row', async t => {
  const f = fixture(t)
  f.row('old', { created_at: 900 }); f.log('old', [user('requested task')])
  f.row('target', { created_at: 1100 }); f.log('target', [user('requested task')])
  f.row('newest', { created_at: 1200 }); f.log('newest', [user('another task')])
  const evidence = { since: 1000, baselineBytes: 0, task: 'requested task' }
  assert.equal((await flow.adoptNewSession(f.options, evidence)).id, 'target')
  f.row('second', { created_at: 1300 }); f.log('second', [user('requested task')])
  await assert.rejects(flow.adoptNewSession(f.options, evidence), { code: 'AMBIGUOUS_SESSION' })
})
test('waiting a resumed turn cannot accept the old completed answer', async t => {
  const f = fixture(t); f.row('a')
  const baselineBytes = f.log('a', [user('old'), assistant('old answer')])
  const evidence = { sessionId: 'a', task: 'new', baselineBytes, since: 2000, baselineActivityAt: 1000 }
  const waiting = await flow.waitForRun(f.options, { sessionId: 'a', evidence, timeoutSec: 0.01 })
  assert.equal(waiting.done, false)
  f.log('a', [user('new'), assistant('new answer')], true)
  assert.equal((await flow.waitForRun(f.options, { sessionId: 'a', evidence, timeoutSec: 0.01 })).done, false, 'old terminal metadata must still be rejected')
  f.db.prepare('update sessions set updated_at=3000,last_activity_at=3000 where id=?').run('a')
  const done = await flow.waitForRun(f.options, { sessionId: 'a', evidence, timeoutSec: 0.01 })
  assert.equal(done.done, true); assert.equal(done.turn.answer, 'new answer')
})
test('superseded or duplicate new turns fail rather than mix answers', () => {
  const evidence = { baselineBytes: 10, task: 'target' }
  assert.throws(() => flow.turnEvidence({ userEvents: [{ offset: 12, text: 'target' }, { offset: 90, text: 'other' }], assistantEvents: [{ offset: 100, text: 'wrong' }] }, evidence), { code: 'TURN_SUPERSEDED' })
})
test('default collection does not call an entire workspace a set of outputs', async t => {
  const f = fixture(t); f.row('a'); f.log('a', [user('task'), assistant('answer')])
  fs.writeFileSync(path.join(f.cwd, 'unrelated.txt'), 'input')
  const result = await flow.collect(f.options, { sessionId: 'a' })
  assert.deepEqual(result.originals, [])
})
test('copies preserve subdirectories, deduplicate identical data and never overwrite', t => {
  const f = fixture(t); const output = path.join(f.root, 'copies')
  for (const folder of ['a', 'b']) { fs.mkdirSync(path.join(f.cwd, folder)); fs.writeFileSync(path.join(f.cwd, folder, 'report.md'), folder) }
  const one = flow.copyCandidate(path.join(f.cwd, 'a', 'report.md'), output, f.cwd)
  const two = flow.copyCandidate(path.join(f.cwd, 'b', 'report.md'), output, f.cwd)
  assert.notEqual(one.to, two.to)
  assert.equal(flow.copyCandidate(one.from, output, f.cwd).skipped, 'identical')
  fs.writeFileSync(one.from, 'new')
  const changed = flow.copyCandidate(one.from, output, f.cwd)
  assert.notEqual(changed.to, one.to); assert.equal(fs.readFileSync(one.to, 'utf8'), 'a')
})
test('a second Node process cannot enter an owned bridge lock', async t => {
  const f = fixture(t)
  await withLock(f.lockPath, async () => {
    const script = `import {withLock} from ${JSON.stringify(new URL('../lib/lock.js', import.meta.url).href)}; try { await withLock(${JSON.stringify(f.lockPath)},async()=>{});process.exitCode=9 } catch(e) { console.log(e.code) }`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 0); assert.equal(child.stdout.trim(), 'BRIDGE_BUSY')
  })
  assert.equal(fs.existsSync(f.lockPath), false)
})
test('lock is released on an operation error', async t => {
  const f = fixture(t)
  await assert.rejects(withLock(f.lockPath, async () => { throw new Error('failure') }))
  assert.equal(fs.existsSync(f.lockPath), false)
})
