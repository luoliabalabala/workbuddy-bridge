/** Host-independent WorkBuddy operations. SQLite and transcripts are read-only. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureRunning } from './app.js'
import { debuggerVersion, waitForWindows, withWindow, sleep } from './cdp.js'
import * as dom from './dom.js'
import * as store from './store.js'
import { DB_PATH, transcriptPath } from './paths.js'
import helperPath from './helper-path.js'
import { isBusy, taskHash, createTicket, saveTicket, loadTicket, existingRequest, evidenceOf, observe } from './dispatch.js'

const fail = (code, text) => Object.assign(new Error(text), { code })
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const dbOptions = options => ({ dbPath: options.dbPath, helperPath: options.helperPath })
const transcript = (options, row) => store.readTranscript(row.id, row.cwd, dbOptions(options))

export function resolveOptions(config = {}) {
  return { ...config, port: Number(config.port) || 9222, launchTimeoutMs: Number(config.launchTimeoutMs) || 30000, waitTimeoutSec: Number(config.waitTimeoutSec) || 30, autoRestart: config.autoRestart !== false, dbPath: config.dbPath ?? DB_PATH, helperPath }
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
  const identity = await withWindow(options.port, 'main', dom.readIdentity)
  if (identity.sessionId !== row.id) throw Object.assign(fail('SESSION_NOT_VERIFIED', `Expected session ${row.id}; observed ${identity.sessionId ?? (identity.home ? 'home' : 'unknown')}. No message was sent.`), { details: { expected: row.id, observed: identity } })
  const state = await withWindow(options.port, 'main', dom.readState)
  return state
}
export async function open(options, { session = 'new' } = {}) {
  // Resolve and reject ambiguous history before changing the UI.
  const row = session === 'new' ? undefined : await resolveSession(options, session)
  await ready(options)
  if (!row) {
    await withWindow(options.port, 'main', dom.openNewTask)
    return { ok: true, text: 'Opened new task.', state: await withWindow(options.port, 'main', dom.readState) }
  }
  await withWindow(options.port, 'main', connection => dom.openSessionById(connection, row.id))
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
export function turnEvidence(log, evidence, { allowSuperseded = false } = {}) {
  const users = (log.userEvents ?? []).filter(event => event.offset >= evidence.baselineBytes)
  const matching = users.filter(event => evidence.taskHash ? taskHash(event.text) === evidence.taskHash : normalize(event.text) === normalize(evidence.task))
  if (matching.length > 1) throw fail('AMBIGUOUS_TURN', 'The task text appears multiple times after the baseline; cannot select a turn.')
  const user = matching[0]
  if (!user) return { userObserved: false, answer: undefined }
  const following = users.find(event => event.offset > user.offset)
  if (following && !allowSuperseded) throw fail('TURN_SUPERSEDED', 'Another user turn appeared after the submitted task. Inspect the session before continuing.')
  const answer = (log.assistantEvents ?? []).filter(event => event.offset > user.offset && (!following || event.offset < following.offset)).at(-1)?.text
  return { userObserved: true, answer, userOffset: user.offset, userId: user.id, userTimestamp: user.timestamp, superseded: !!following }
}
export async function adoptNewSession(options, evidence) {
  const response = evidence.beforeSessions ? await store.listSessions({ ...dbOptions(options), limit: 200 }) : await store.sessionsSince(evidence.since, dbOptions(options))
  if (!response.ok) throw fail('DB_UNAVAILABLE', response.error)
  const matches = response.rows.filter(row => {
    const before = evidence.beforeSessions?.[row.id]
    if (evidence.sessionId && row.id !== evidence.sessionId) return false
    if (!before && Number(row.created_at) < (evidence.preparedAt ?? evidence.since)) return false
    const turn = turnEvidence(transcript(options, row), { ...evidence, baselineBytes: before?.bytes ?? evidence.baselineBytes ?? 0 })
    return turn.userObserved && (!turn.userTimestamp || Number(turn.userTimestamp) >= evidence.since)
  })
  if (matches.length > 1) throw fail('AMBIGUOUS_SESSION', 'Multiple newly created sessions contain this task; no result was adopted.')
  return matches[0]
}
export async function send(options, { task, sessionId, requestId, requestedSettings } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw fail('INVALID_ARGUMENT', 'task is empty')
  const existing = existingRequest(options, requestId)
  if (existing) {
    if (existing.taskHash !== taskHash(task)) throw fail('REQUEST_CONFLICT', 'requestId already belongs to another task.')
    return recover(options, { dispatchId: existing.dispatchId })
  }
  await ready(options)
  const row = sessionId ? await resolveSession(options, sessionId) : undefined
  if (row && isBusy(row.status)) throw fail('SESSION_BUSY', 'The target session already has an active task; no new task was sent.')
  const baseline = row ? transcript(options, row) : undefined
  if (row && !baseline.path) throw fail('TRANSCRIPT_UNAVAILABLE', 'Cannot establish a transcript baseline; no task was sent.')
  if (row) await verifyVisible(options, row)
  else {
    const state = await withWindow(options.port, 'main', dom.readState)
    if (state.view !== 'home') throw fail('SESSION_REQUIRED', 'Sending to a conversation requires its explicit session id.')
  }
  const prior = existingRequest(options, requestId)
  if (prior) {
    if (prior.taskHash !== taskHash(task)) throw fail('REQUEST_CONFLICT', 'requestId already belongs to another task.')
    return recover(options, { dispatchId: prior.dispatchId })
  }
  const preparedAt = Date.now()
  const beforeResponse = await store.listSessions({ ...dbOptions(options), limit: 200 })
  if (!beforeResponse.ok) throw fail('DB_UNAVAILABLE', 'Cannot establish session baselines; nothing sent.')
  const beforeSessions = Object.fromEntries(beforeResponse.rows.map(r => {
    const file = transcriptPath(r.id, r.cwd, dbOptions(options))
    let bytes = 0
    try { bytes = fs.statSync(file).size } catch { /* A reserved new session may not have a transcript yet. */ }
    return [r.id, { bytes }]
  }))
  const typed = await withWindow(options.port, 'main', connection => dom.typeTask(connection, task))
  if (typed.sendDisabled) throw fail('SEND_DISABLED', 'Composer is not ready; no task was sent.')
  // Immediately preceding the click: a historical completed flag is not this turn.
  const startedAt = Date.now()
  const selectionAtSubmit = await withWindow(options.port, 'main', dom.readState)
  delete selectionAtSubmit.composerText
  const ticket = createTicket(options, { task, requestId, sessionId: row?.id, since: startedAt, preparedAt, beforeSessions, requestedSettings, baselineBytes: baseline?.bytes ?? 0, baselineActivityAt: Math.max(Number(row?.updated_at) || 0, Number(row?.last_activity_at) || 0) })
  ticket.selectionAtSubmit = selectionAtSubmit
  // Do not persist composer text (which may include private task data).
  delete ticket.selectionAtSubmit.composerText
  ticket.state = 'send-outcome-unknown'
  saveTicket(options, ticket)
  try { await withWindow(options.port, 'main', dom.sendComposer) }
  catch (error) { ticket.lastError = error.message; saveTicket(options, ticket); return pendingTicket(ticket) }
  ticket.state = 'pending-observation'
  saveTicket(options, ticket)
  if (!row) {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline && !ticket.sessionId) {
      let adopted
      try { adopted = await adoptNewSession(options, ticket) } catch (error) { ticket.lastError = error.message; saveTicket(options, ticket); break }
      if (adopted) {
        ticket.sessionId = adopted.id
        ticket.baselineBytes = beforeSessions[adopted.id]?.bytes ?? 0
        observe(ticket, adopted, 'bound')
      }
      else await sleep(700)
    }
  }
  if (!ticket.sessionId) return pendingTicket(saveTicket(options, ticket))
  ticket.state = 'bound'
  saveTicket(options, ticket)
  return { ok: true, text: `Task sent to ${ticket.sessionId}.`, startedAt, dispatchId: ticket.dispatchId, sessionId: ticket.sessionId, evidence: evidenceOf(ticket), selectionAtSubmit: ticket.selectionAtSubmit }
}
function pendingTicket(ticket) {
  return { ok: true, status: 'pending-observation', submitted: ticket.state === 'send-outcome-unknown' ? null : ticket.state !== 'prepared', sendState: ticket.state, needsRecovery: true, text: 'Recover with dispatchId before considering another send. The durable ticket preserves the send state and attribution.', dispatchId: ticket.dispatchId, sessionId: ticket.sessionId, evidence: evidenceOf(ticket), startedAt: ticket.since }
}
export async function recover(options, { dispatchId, sessionId, evidence } = {}) {
  let ticket
  if (dispatchId) ticket = loadTicket(options, dispatchId)
  else {
    if (!evidence?.task || !Number.isFinite(evidence.since) || !sessionId) throw fail('INVALID_EVIDENCE', 'Legacy recovery requires the original task evidence and an explicit sessionId.')
    const row = await resolveSession(options, sessionId)
    const turn = turnEvidence(transcript(options, row), evidence)
    if (!turn.userObserved || !turn.userTimestamp || Number(turn.userTimestamp) < evidence.since) throw fail('RECOVERY_NOT_VERIFIED', 'Legacy evidence does not match a recorded user turn after send.')
    ticket = createTicket(options, { task: evidence.task, ...evidence, sessionId: row.id, source: 'verified-legacy-recovery' })
  }
  if (sessionId && ticket.sessionId && ticket.sessionId !== sessionId) throw fail('INVALID_EVIDENCE', 'Dispatch is already bound to another session.')
  const row = ticket.sessionId ? await resolveSession(options, ticket.sessionId) : sessionId ? await resolveSession(options, sessionId) : await adoptNewSession(options, ticket)
  if (!row) return pendingTicket(ticket)
  const baselineBytes = ticket.beforeSessions?.[row.id]?.bytes ?? ticket.baselineBytes
  const turn = turnEvidence(transcript(options, row), { ...ticket, baselineBytes }, {allowSuperseded:true})
  if (!turn.userObserved && ticket.sessionId === row.id) return pendingTicket(ticket)
  if (!turn.userObserved || turn.userTimestamp && Number(turn.userTimestamp) < ticket.since) throw fail('RECOVERY_NOT_VERIFIED', 'Session has no matching new user turn for this dispatch.')
  ticket.sessionId = row.id
  ticket.baselineBytes = baselineBytes
  ticket.userMessageId = turn.userId
  ticket.state = turn.superseded ? 'superseded' : isBusy(row.status) ? 'working' : row.status
  ticket.superseded = turn.superseded
  observe(ticket, row, 'recovered')
  saveTicket(options, ticket)
  return { ok: true, text: `Recovered dispatch ${ticket.dispatchId} and session ${row.id}.`, dispatchId: ticket.dispatchId, sessionId: row.id, status: ticket.state, superseded:turn.superseded, evidence: evidenceOf(ticket), observations: ticket.observations, selectionAtSubmit: ticket.selectionAtSubmit, wallElapsedMs: Date.now()-ticket.since, hostWaitElapsedMs: ticket.hostWaitElapsedMs ?? 0, lastProgressObservedAt: ticket.lastProgressObservedAt, usage: 'NOT_MEASURED', backendModel: 'NOT_INDEPENDENTLY_OBSERVED', modelMetadataNote: 'Global/session metadata can change with other tasks; this is not proof that the running backend model changed.' }
}
export async function waitForRun(options, { sessionId, timeoutSec, evidence, dispatchId } = {}) {
  let ticket
  if (dispatchId || evidence?.dispatchId) {
    const recovered = await recover(options, { dispatchId: dispatchId ?? evidence.dispatchId, sessionId })
    if (recovered.needsRecovery) return { ...recovered, done: false }
    evidence = recovered.evidence
    sessionId = recovered.sessionId
    ticket = loadTicket(options, evidence.dispatchId)
  }
  const row = await resolveSession(options, sessionId)
  if (evidence && evidence.sessionId !== row.id) throw fail('INVALID_EVIDENCE', 'evidence sessionId must match the target session.')
  if (evidence && (!Number.isSafeInteger(evidence.baselineBytes) || evidence.baselineBytes < 0 || (!evidence.task && !evidence.taskHash))) throw fail('INVALID_EVIDENCE', 'Invalid turn evidence.')
  const waitStartedAt = Date.now()
  let sampleAt = waitStartedAt
  const deadline = Date.now() + (timeoutSec ?? options.waitTimeoutSec) * 1000
  let last = row
  let activeObserved = false
  do {
    const response = await store.getSession(row.id, dbOptions(options))
    if (!response.ok || !response.row) throw fail('DB_UNAVAILABLE', response.error ?? 'Session disappeared.')
    last = response.row
    if (isBusy(last.status)) activeObserved = true
    const log = transcript(options, last)
    const turn = evidence ? turnEvidence(log, evidence, {allowSuperseded:true}) : { userObserved: true, answer: log.lastAssistant }
    if (turn.superseded) return {done:true,status:'superseded',sessionId:last.id,row:last,turn}
    if (ticket) {
      ticket = loadTicket(options, ticket.dispatchId)
      if (ticket.lastProgressBytes !== log.bytes) { ticket.lastProgressBytes = log.bytes; ticket.lastProgressObservedAt = Date.now() }
      ticket.state = last.status
      observe(ticket, last, 'wait')
      ticket.hostWaitElapsedMs = (ticket.hostWaitElapsedMs ?? 0) + Date.now() - sampleAt
      sampleAt = Date.now()
      saveTicket(options, ticket)
    }
    const activity = Math.max(Number(last.updated_at) || 0, Number(last.last_activity_at) || 0)
    const freshStatus = !evidence || evidence.baselineBytes === 0 || activeObserved || activity >= evidence.since && activity > (evidence.baselineActivityAt ?? 0)
    if (last.status === 'error' && freshStatus && turn.userObserved) return { done: true, status: 'error', sessionId: last.id, row: last, turn }
    if (last.status === 'completed' && freshStatus && turn.userObserved && turn.answer) return { done: true, status: 'completed', sessionId: last.id, row: last, turn }
    if (['cancelled','canceled','interrupted','aborted'].includes(last.status) && turn.userObserved) return { done: true, status: last.status, sessionId: last.id, row: last, turn }
    if (Date.now() >= deadline) break
    await sleep(Math.min(1000, Math.max(1, deadline - Date.now())))
  } while (Date.now() <= deadline)
  return { done: false, status: last.status, sessionId: last.id, row: last }
}

export async function cancel(options, { dispatchId } = {}) {
  const recovered = await recover(options, { dispatchId })
  if (recovered.needsRecovery) return { ok: false, code: 'SESSION_NOT_OBSERVED', text: 'Recover a verified session before interrupting.', dispatchId }
  const ticket = loadTicket(options, dispatchId)
  if (ticket.superseded) throw fail('TURN_SUPERSEDED', 'A newer turn owns this session; no interrupt was sent.')
  const row = await resolveSession(options, ticket.sessionId)
  if (!isBusy(row.status)) return { ok: true, text: `No interrupt sent: session is ${row.status}.`, status: row.status, dispatchId, sessionId: row.id, requested: false }
  if (!await debuggerVersion(options.port)) throw fail('NO_PORT', 'Cancel requires the existing debug connection; no restart or kill was attempted.')
  await open({ ...options, autoRestart:false }, { session: row.id })
  // Recheck immediately before clicking stop; never interrupt a superseding turn.
  turnEvidence(transcript(options, row), ticket)
  const request = await withWindow(options.port, 'main', connection => dom.stopTurn(connection, row.id))
  ticket.cancelRequestedAt = Date.now()
  ticket.state = 'cancel-requested'
  saveTicket(options, ticket)
  const until = Date.now() + 3000
  let after = row
  while (Date.now() < until) {
    after = await resolveSession(options, row.id)
    if (!isBusy(after.status)) break
    await sleep(300)
  }
  return { ok: true, text: isBusy(after.status) ? 'Interrupt requested; stop is not yet confirmed.' : `Interrupt requested; observed status ${after.status}.`, dispatchId, sessionId: row.id, requested: request.requested, confirmed: !isBusy(after.status), status: after.status }
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
export async function collect(options, { sessionId, outputDir, mode = 'auto', since, answer, allowedOutputDirs = [] } = {}) {
  if (mode === 'copy' && (!outputDir || !allowedOutputDirs.length)) throw fail('COPY_ROOTS_REQUIRED', 'Copy requires outputDir and explicit allowedOutputDirs source roots.')
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
  const isAllowed = file => allowedOutputDirs.some(root => {
    try { const relative=path.relative(fs.realpathSync(root),fs.realpathSync(file));return relative==='' || (!relative.startsWith('..')&&!path.isAbsolute(relative)) } catch { return false }
  })
  const files = [...candidates.values()].filter(file => !allowedOutputDirs.length || isAllowed(file.path))
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
  return { ok: copies.every(copy => !copy.error), text: lines.join('\n'), sessionId: row.id, answer: textAnswer, files, categories: { modifiedCandidates: files.filter(f=>f.evidence.startsWith('modified')), referencedCandidates: files.filter(f=>f.evidence.startsWith('referenced')), independentlyAttributedOutputs: [], attribution: 'NOT_ESTABLISHED_BY_PATHS_OR_TIMESTAMPS' }, originals: files.map(file => file.path), copies, cwd: row.cwd, summaryPath }
}
export async function run(options, args = {}) {
  const trace = []
  const previous = existingRequest(options, args.requestId)
  if (previous) {
    if (previous.taskHash !== taskHash(args.task)) throw fail('REQUEST_CONFLICT', 'requestId belongs to another task.')
    return recover(options, { dispatchId: previous.dispatchId })
  }
  if (args.restart) { await ready(options, { restart: true }); trace.push('restarted with explicit request') }
  const opened = await open(options, { session: args.session ?? 'new' })
  trace.push(opened.text)
  const configured = await configure(options, args)
  trace.push(configured.text)
  const sent = await send(options, { task: args.task, sessionId: opened.row?.id, requestId: args.requestId, requestedSettings: { model: args.model, effort: args.effort, contextK: args.contextK, expert: args.expert } })
  trace.push(sent.text)
  if (!sent.ok || sent.needsRecovery) return { ...sent, trace }
  let waited
  try { waited = await waitForRun(options, { sessionId: sent.sessionId, timeoutSec: args.timeoutSec, evidence: sent.evidence }) }
  catch (error) { return { ...sent, ok:false, code:error.code??'OBSERVATION_ERROR', text:`Send completed; observation failed: ${error.message}. Recover the existing dispatch; do not resend.`,trace } }
  trace.push(waited.done ? waited.status : 'timeout; WorkBuddy may still be running')
  if (!waited.done) return { ok: true, status: 'waiting', text: trace.join('\n'), dispatchId: sent.dispatchId, sessionId: sent.sessionId, evidence: sent.evidence, observedStatus: waited.status, done: false, trace }
  const collected = await collect(options, { sessionId: sent.sessionId, since: sent.startedAt, outputDir: args.outputDir, mode: args.mode, allowedOutputDirs: args.allowedOutputDirs, answer: waited.turn.answer ?? '' })
  return { ...collected, ok: waited.status === 'completed' && collected.ok, text: `${trace.join('\n')}\n\n${collected.text}`, dispatchId: sent.dispatchId, sessionId: sent.sessionId, evidence: sent.evidence, status: waited.status, done: true, trace }
}
