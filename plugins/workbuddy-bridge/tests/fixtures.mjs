import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { projectSlug } from '../lib/paths.js'
export function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'wb-bridge-test-')
  const root = fs.mkdtempSync(prefix)
  let db
  t.after(() => {
    db?.close()
    if (!path.resolve(root).startsWith(path.resolve(prefix))) throw new Error('Invalid fixture cleanup target')
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dbPath = path.join(root, 'workbuddy.db')
  db = new DatabaseSync(dbPath)
  db.exec(`create table sessions (id text primary key, title text, custom_title text, status text, model text, expert_id text, expert_locale text, context_window integer, thought_level text, cwd text, permission_mode text, created_at integer, updated_at integer, last_activity_at integer, deleted_at integer)`)
  const cwd = path.join(root, 'workspace')
  fs.mkdirSync(cwd)
  function row(id, extra = {}) {
    const data = { id, title: `Session ${id}`, custom_title: null, status: 'completed', model: 'fixture-model', expert_id: null, expert_locale: null, context_window: 300000, thought_level: '高', cwd, permission_mode: 'default', created_at: 1000, updated_at: 1000, last_activity_at: 1000, deleted_at: null, ...extra }
    db.prepare(`insert or replace into sessions (${Object.keys(data).join(',')}) values (${Object.keys(data).map(() => '?').join(',')})`).run(...Object.values(data))
    return data
  }
  function log(id, events, append = false) {
    const file = path.join(root, 'projects', projectSlug(cwd), `${id}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs[append ? 'appendFileSync' : 'writeFileSync'](file, events.map(event => JSON.stringify(event)).join('\n') + '\n')
    return fs.statSync(file).size
  }
  return { root, cwd, dbPath, db, row, log, options: { dbPath, waitTimeoutSec: 0.01, port: 1, autoRestart: false }, lockPath: path.join(root, 'test.lock') }
}
export const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
export const assistant = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
