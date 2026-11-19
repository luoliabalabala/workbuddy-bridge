/** Host-independent WorkBuddy operations. SQLite and transcripts are read-only. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureRunning } from './app.js'
import { debuggerVersion, waitForWindows, withWindow, sleep } from './cdp.js'
import * as dom from './dom.js'
import * as store from './store.js'
import { DB_PATH } from './paths.js'
import helperPath from './helper-path.js'

const fail = (code, text) => Object.assign(new Error(text), { code })
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const dbOptions = options => ({ dbPath: options.dbPath, helperPath: options.helperPath })
const transcript = (options, row) => store.readTranscript(row.id, row.cwd, dbOptions(options))

export function resolveOptions(config = {}) {
  return { ...config, port: Number(config.port) || 9222, launchTimeoutMs: Number(config.launchTimeoutMs) || 30000, waitTimeoutSec: Number(config.waitTimeoutSec) || 900, autoRestart: config.autoRestart === true, dbPath: config.dbPath ?? DB_PATH, helperPath }
}
async function ready(options, extra = {}) { return ensureRunning({ ...options, ...extra }) }
export function describeSession(row) {
  return row ? `${row.id} · ${row.custom_title || row.title || '(untitled)'} · ${row.status} · ${row.model ?? '?'}` : 'unknown session'
}

export async function status(options, { restart = false, launch = false } = {}) {
  let app
  if (launch || restart) app = await ready(options, { restart })
  else if (!await debuggerVersion(options.port)) return { ok: false, code: 'NO_PORT', text: `No reachable CDP endpoint on 127.0.0.1:${options.port}. Application was not launched or restarted.` }
  const windows = await waitForWindows(options.port, { timeoutMs: app?.launched ? 20000 : 3000 })
  if (!windows.main) return { ok: false, code: 'NO_WINDOW', text: 'No WorkBuddy main window found on the debug port.' }
  const state = await withWindow(options.port, 'main', dom.readState)
  return { ok: true, text: `WorkBuddy · port ${options.port} · view ${state.view} · model ${state.model ?? '?'}${app?.launched ? ' · launched' : ''}`, state, app }
}
export async function history(options, { query, limit = 20 } = {}) {
  const response = await store.listSessions({ ...dbOptions(options), query, limit })
  if (!response.ok) return { ok: false, code: 'DB_UNAVAILABLE', text: response.error, rows: [] }
  return { ok: true, text: response.rows.length ? response.rows.map(row => `${describeSession(row)}\n  cwd: ${row.cwd ?? '-'}`).join('\n') : 'No sessions found.', rows: response.rows }
}
export async function models(options) {
  await ready(options)
  const info = await withWindow(options.port, 'main', dom.readModelMenu)
  return { ok: true, text: info.items.map(item => `${item.name}${item.selected ? ' · selected' : ''}${item.credits ? ` · ${item.credits}` : ''}`).join('\n'), models: info.items }
}
export async function experts(options, args = {}) {
  await ready(options)
  const info = await withWindow(options.port, 'main', connection => dom.readExperts(connection, args))
  return { ok: true, text: info.experts.map(item => `${item.name} · ${item.role ?? ''}${item.canSummon ? '' : ' · unavailable'}`).join('\n'), experts: info.experts }
}
export async function resolveSession(options, value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('SESSION_REQUIRED', 'An explicit session is required.')
  const exact = await store.getSession(value, dbOptions(options))
  if (!exact.ok) throw fail('DB_UNAVAILABLE', exact.error)
  if (exact.row && exact.row.deleted_at == null) return exact.row
  const response = await store.listSessions({ ...dbOptions(options), limit: 200 })
  if (!response.ok) throw fail('DB_UNAVAILABLE', response.error)
  let matches = response.rows.filter(row => row.id.startsWith(value))
  if (!matches.length) {
    const titles = await store.listSessions({ ...dbOptions(options), query: value, limit: 200 })
    if (!titles.ok) throw fail('DB_UNAVAILABLE', titles.error)
    matches = titles.rows.filter(row => `${row.custom_title ?? ''} ${row.title ?? ''}`.includes(value))
  }
  if (matches.length !== 1) throw fail(matches.length ? 'AMBIGUOUS_SESSION' : 'SESSION_NOT_FOUND', matches.length ? `Session matches ${matches.length} records; use the exact id.` : 'Session not found; use an exact id (prefix lookup covers recent 200 records).')
  return matches[0]
}
async function verifyVisible(options, row) {
  const title = row.custom_title || row.title
  const state = await withWindow(options.port, 'main', dom.readState)
  if (state.view !== 'conversation' || normalize(state.title) !== normalize(title)) throw fail('SESSION_NOT_VERIFIED', 'Visible conversation does not match the selected title; no task was sent.')
  return state
}
export async function open(options, { session = 'new' } = {}) {
  // Resolve and reject ambiguous history before changing the UI.
  const row = session === 'new' ? undefined : await resolveSession(options, session)
  if (row) {
    const title = row.custom_title || row.title
    if (!title) throw fail('SESSION_NOT_VERIFIED', 'Session has no visible title.')
    const duplicates = await store.query({ op: 'title', title }, dbOptions(options))
    if (!duplicates.ok || duplicates.rows?.length !== 1) throw fail('AMBIGUOUS_SESSION', 'History is opened by title; its title must be unique in the database. Rename duplicates in WorkBuddy first.')
  }
  await ready(options)
  if (!row) {
    await withWindow(options.port, 'main', dom.openNewTask)
    return { ok: true, text: 'Opened new task.', state: await withWindow(options.port, 'main', dom.readState) }
  }
  await withWindow(options.port, 'main', connection => dom.openSessionByTitle(connection, row.custom_title || row.title))
  const state = await verifyVisible(options, row)
  return { ok: true, text: `Opened ${describeSession(row)}`, row, sessionId: row.id, state }
}
async function retry(fn) {
  try { return await fn() } catch { await sleep(600); return fn() }
}
export async function configure(options, { model, effort, contextK, expert } = {}) {
  await ready(options)
  return withWindow(options.port, 'main', async connection => {
    const before = await dom.readState(connection)
    const applied = []
    // Summoning an expert can reset the home composer; select the model after it.
    if (expert !== undefined) {
      if (before.view !== 'home') throw fail('EXPERT_REQUIRES_NEW', 'Experts can only be selected on a new task; nothing sent.')
      const result = await dom.summonExpert(connection, expert)
      applied.push(`expert: ${result.summoned}`)
    }
    if (model !== undefined) { await dom.selectModel(connection, model); applied.push(`model: ${model}`) }
    const current = await dom.readState(connection)
    const wantedModel = model ?? current.model
    if (effort !== undefined) { const result = await retry(() => dom.setEffort(connection, effort, { model: wantedModel })); applied.push(`effort: ${result.active ?? result.requested}`) }
    if (contextK !== undefined) { const result = await retry(() => dom.setContextWindow(connection, Number(contextK), { model: wantedModel })); applied.push(`context: ${result.active ?? contextK}`) }
    const state = await dom.readState(connection)
    if (wantedModel && normalize(state.model) !== normalize(wantedModel)) throw fail('CONFIG_NOT_VERIFIED', 'Model changed while configuring; no task was sent. Inspect the UI and retry.')
    return { ok: true, text: applied.join('\n') || 'No settings requested.', applied, state }
  })
}

/** Bind a new send to an appended user event and subsequent assistant events. */
export function turnEvidence(log, evidence) {
  const users = (log.userEvents ?? []).filter(event => event.offset >= evidence.baselineBytes)
  const matching = users.filter(event => normalize(event.text) === normalize(evidence.task))
  if (matching.length > 1) throw fail('AMBIGUOUS_TURN', 'The task text appears multiple times after the baseline; cannot select a turn.')
  const user = matching[0]
  if (!user) return { userObserved: false, answer: undefined }
  const following = users.find(event => event.offset > user.offset)
  if (following) throw fail('TURN_SUPERSEDED', 'Another user turn appeared after the submitted task. Inspect the session before continuing.')
  const answer = (log.assistantEvents ?? []).filter(event => event.offset > user.offset).at(-1)?.text
  return { userObserved: true, answer, userOffset: user.offset }
}
export async function adoptNewSession(options, evidence) {
  const response = await store.sessionsSince(evidence.since, dbOptions(options))
  if (!response.ok) throw fail('DB_UNAVAILABLE', response.error)
  const matches = response.rows.filter(row => turnEvidence(transcript(options, row), { ...evidence, baselineBytes: 0 }).userObserved)
  if (matches.length > 1) throw fail('AMBIGUOUS_SESSION', 'Multiple newly created sessions contain this task; no result was adopted.')
  return matches[0]
}
export async function send(options, { task, sessionId } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw fail('INVALID_ARGUMENT', 'task is empty')
  await ready(options)
  const row = sessionId ? await resolveSession(options, sessionId) : undefined
  if (row && ['active', 'running', 'pending'].includes(row.status)) throw fail('SESSION_BUSY', 'The target session already has an active task; no new task was sent.')
  const baseline = row ? transcript(options, row) : undefined
  if (row && !baseline.path) throw fail('TRANSCRIPT_UNAVAILABLE', 'Cannot establish a transcript baseline; no task was sent.')
  if (row) await verifyVisible(options, row)
  else {
    const state = await withWindow(options.port, 'main', dom.readState)
    if (state.view !== 'home') throw fail('SESSION_REQUIRED', 'Sending to a conversation requires its explicit session id.')
  }
  const typed = await withWindow(options.port, 'main', connection => dom.typeTask(connection, task))
  if (typed.sendDisabled) throw fail('SEND_DISABLED', 'Composer is not ready; no task was sent.')
  // Immediately preceding the click: a historical completed flag is not this turn.
  const startedAt = Date.now()
  const evidence = { task, since: startedAt, sessionId: row?.id, baselineBytes: baseline?.bytes ?? 0, baselineActivityAt: Math.max(Number(row?.updated_at) || 0, Number(row?.last_activity_at) || 0) }
  await withWindow(options.port, 'main', dom.sendComposer)
  if (!row) {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !evidence.sessionId) {
      const adopted = await adoptNewSession(options, evidence)
      if (adopted) evidence.sessionId = adopted.id
      else await sleep(700)
    }
  }
  if (!evidence.sessionId) return { ok: false, code: 'SESSION_NOT_OBSERVED', text: 'Task was sent, but its new session is not yet verified. Do not resend automatically.', typed, startedAt, evidence }
  return { ok: true, text: `Task sent to ${evidence.sessionId}.`, typed, startedAt, sessionId: evidence.sessionId, evidence }
}
export async function waitForRun(options, { sessionId, timeoutSec, evidence } = {}) {
  const row = await resolveSession(options, sessionId)
  if (evidence && evidence.sessionId !== row.id) throw fail('INVALID_EVIDENCE', 'evidence sessionId must match the target session.')
  if (evidence && (!Number.isSafeInteger(evidence.baselineBytes) || evidence.baselineBytes < 0 || !evidence.task)) throw fail('INVALID_EVIDENCE', 'Invalid turn evidence.')
  const deadline = Date.now() + (timeoutSec ?? options.waitTimeoutSec) * 1000
  let last = row
  let activeObserved = false
  do {
    const response = await store.getSession(row.id, dbOptions(options))
    if (!response.ok || !response.row) throw fail('DB_UNAVAILABLE', response.error ?? 'Session disappeared.')
    last = response.row
    if (['active', 'running', 'pending'].includes(last.status)) activeObserved = true
    const log = transcript(options, last)
    const turn = evidence ? turnEvidence(log, evidence) : { userObserved: true, answer: log.lastAssistant }
    const activity = Math.max(Number(last.updated_at) || 0, Number(last.last_activity_at) || 0)
    const freshStatus = !evidence || evidence.baselineBytes === 0 || activeObserved || activity >= evidence.since && activity > (evidence.baselineActivityAt ?? 0)
    if (last.status === 'error' && freshStatus && turn.userObserved) return { done: true, status: 'error', sessionId: last.id, row: last, turn }
    if (last.status === 'completed' && freshStatus && turn.userObserved && turn.answer) return { done: true, status: 'completed', sessionId: last.id, row: last, turn }
    if (Date.now() >= deadline) break
    await sleep(Math.min(1000, Math.max(1, deadline - Date.now())))
  } while (Date.now() <= deadline)
  return { done: false, status: last.status, sessionId: last.id, row: last }
}

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
export function copyCandidate(source, outputDir, cwd) {
  const realRelative = path.relative(fs.realpathSync(cwd), fs.realpathSync(source))
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw fail('FILE_OUTSIDE_WORKSPACE', 'Referenced file resolves outside the workspace.')
  const relative = path.relative(cwd, source)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('FILE_OUTSIDE_WORKSPACE', 'Only workspace files may be copied.')
  let target = path.join(outputDir, 'files', relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) {
    if (digest(source) === digest(target)) return { from: source, to: target, skipped: 'identical' }
    const parsed = path.parse(target)
    target = path.join(parsed.dir, `${parsed.name}-${digest(source).slice(0, 12)}${parsed.ext}`)
    if (fs.existsSync(target) && digest(source) === digest(target)) return { from: source, to: target, skipped: 'identical' }
  }
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  return { from: source, to: target }
}
export async function collect(options, { sessionId, outputDir, mode = 'auto', since, answer } = {}) {
  const row = await resolveSession(options, sessionId)
  const log = transcript(options, row)
  const textAnswer = answer ?? log.lastAssistant
  const workspace = row.cwd && fs.existsSync(row.cwd) ? store.listFiles(row.cwd) : []
  const candidates = new Map()
  // Timestamps prove modification, not which agent or task caused it.
  if (since) for (const file of workspace.filter(item => item.mtimeMs >= since)) candidates.set(path.resolve(file.path), { path: path.resolve(file.path), evidence: 'modified-since-send; attribution-unverified' })
  for (const file of log.files) {
    if (!path.isAbsolute(file)) continue
    try {
      if (!fs.statSync(file).isFile() || since && fs.statSync(file).mtimeMs < since) continue
      const absolute = path.resolve(file)
      if (!candidates.has(absolute)) candidates.set(absolute, { path: absolute, evidence: 'referenced-in-transcript; output-unverified' })
    } catch { /* Missing referenced files are not deliverables. */ }
  }
  const files = [...candidates.values()]
  const copies = []
  if (mode === 'copy' && outputDir && row.cwd) {
    for (const file of files) {
      try { copies.push(copyCandidate(file.path, outputDir, row.cwd)) }
      catch (error) { copies.push({ from: file.path, error: error.message }) }
    }
  }
  const lines = [`session: ${row.id} · ${row.status}`, `workspace: ${row.cwd ?? '?'}`, `last answer:\n${textAnswer ?? '(not observed)'}`, 'Candidate files (not proof of newly generated outputs):', ...files.map(file => `- ${file.path} · ${file.evidence}`)]
  let summaryPath
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true })
    summaryPath = path.join(outputDir, `workbuddy-result-${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.md`)
    fs.writeFileSync(summaryPath, `# WorkBuddy result\n\n${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
    lines.push(`summary: ${summaryPath}`)
  }
  return { ok: copies.every(copy => !copy.error), text: lines.join('\n'), sessionId: row.id, answer: textAnswer, files, originals: files.map(file => file.path), copies, cwd: row.cwd, summaryPath }
}
export async function run(options, args = {}) {
  const trace = []
  if (args.restart) { await ready(options, { restart: true }); trace.push('restarted with explicit request') }
  const opened = await open(options, { session: args.session ?? 'new' })
  trace.push(opened.text)
  const configured = await configure(options, args)
  trace.push(configured.text)
  const sent = await send(options, { task: args.task, sessionId: opened.row?.id })
  trace.push(sent.text)
  if (!sent.ok) return { ...sent, trace }
  const waited = await waitForRun(options, { sessionId: sent.sessionId, timeoutSec: args.timeoutSec, evidence: sent.evidence })
  trace.push(waited.done ? waited.status : 'timeout; WorkBuddy may still be running')
  if (!waited.done) return { ok: false, code: 'WAIT_TIMEOUT', text: trace.join('\n'), sessionId: sent.sessionId, evidence: sent.evidence, status: waited.status, done: false, trace }
  const collected = await collect(options, { sessionId: sent.sessionId, since: sent.startedAt, outputDir: args.outputDir, mode: args.mode, answer: waited.turn.answer ?? '' })
  return { ...collected, ok: waited.status === 'completed' && collected.ok, text: `${trace.join('\n')}\n\n${collected.text}`, sessionId: sent.sessionId, evidence: sent.evidence, status: waited.status, done: true, trace }
}
