/**
 * The high-level WorkBuddy flows: look, open, configure, send, wait, collect.
 *
 * Each function is one step a caller can run alone, and `run` chains them the
 * way the user described the job: resume or start a session, choose model /
 * context / effort / expert, paste the task, let WorkBuddy finish, then hand
 * back the files it produced — without copying what already exists.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureRunning } from './app.js'
import { openWindows, waitForWindows, withWindow, sleep } from './cdp.js'
import * as dom from './dom.js'
import * as store from './store.js'
import { DB_PATH } from './paths.js'
import helperPath from './helper-path.js'

/**
 * Retry a UI step that depends on a hover submenu.
 *
 * Opening a model row's effort/context panel goes through a hover-driven
 * submenu that occasionally fails to appear (animation timing, list re-sort).
 * The step is idempotent, so retrying it is cheaper than failing the run.
 */
async function withRetry(run, attempts = 2) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      await sleep(600)
    }
  }
  throw lastError
}

/** Runtime options resolved from plugin config plus defaults. */
export function resolveOptions(config = {}) {
  return {
    port: Number(config.port) || 9222,
    launchTimeoutMs: Number(config.launchTimeoutMs) || 30000,
    waitTimeoutSec: Number(config.waitTimeoutSec) || 900,
    autoRestart: config.autoRestart !== false,
    appPath: config.appPath,
    outputRoot: config.outputRoot,
    dbPath: config.dbPath ?? DB_PATH,
    tools: config.tools,
    helperPath,
  }
}

const say = (value) => (value === undefined || value === null || value === '' ? undefined : value)

/** Compact one-line description of a session row. */
export function describeSession(row) {
  if (row === undefined || row === null) return 'unknown session'
  const title = row.custom_title || row.title || '(untitled)'
  const parts = [
    `${String(row.id).slice(0, 8)}`,
    `"${title}"`,
    `status=${row.status ?? '?'}`,
    `model=${row.model ?? '?'}`,
    `expert=${row.expert_id || '-'}`,
    `ctx=${row.context_window ?? '-'}`,
    `effort=${row.thought_level ?? '-'}`,
  ]
  return parts.join(' · ')
}

function toIso(ms) {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : undefined
}

/** Verify the app is up, then report what the main window shows. */
/** Start or relaunch WorkBuddy so the DevTools port is usable (shared entry gate). */
async function ready(options, { restart = false } = {}) {
  return ensureRunning({
    port: options.port,
    launchTimeoutMs: options.launchTimeoutMs,
    appPath: options.appPath,
    tools: options.tools,
    restart,
    autoRestart: options.autoRestart,
    dbPath: options.dbPath,
  })
}

export async function status(options, { restart = false, launch = true } = {}) {
  let app
  if (launch === true) {
    app = await ready(options, { restart })
  }
  const windows = await waitForWindows(options.port, { timeoutMs: app?.launched === true ? 20000 : 12000 })
  if (windows.main === undefined) {
    return { ok: false, text: `WorkBuddy is running (port ${options.port}) but no main window was found.` }
  }
  let state = await withWindow(options.port, 'main', (connection) => dom.readState(connection))
  if (state.view === 'other' && app?.launched === true) {
    // A just-started renderer answers before its React tree has mounted.
    await sleep(1500)
    state = await withWindow(options.port, 'main', (connection) => dom.readState(connection))
  }
  const lines = [
    `WorkBuddy: running${app?.launched === true ? ` (${app.restarted === true ? 'relaunched with the debug port' : 'launched'} via ${app.how})` : ''} on DevTools port ${options.port}`,
    `view: ${state.view}${state.title ? ` · ${state.title}` : ''}`,
    `model: ${state.model ?? 'unknown'}${state.chips.length > 0 ? ` · chips: ${state.chips.join(' | ')}` : ''}`,
    state.contextLabel ? `context: ${state.contextLabel}` : undefined,
    `settings window: ${windows.settings === undefined ? 'closed' : 'open'}`,
  ].filter(Boolean)
  return { ok: true, text: lines.join('\n'), state, windows: Object.keys(windows).filter((key) => windows[key] !== undefined) }
}

/** History sessions straight from the app database, with a DOM fallback. */
export async function history(options, { query, limit = 20 } = {}) {
  const response = await store.listSessions({ query, limit, dbPath: options.dbPath, helperPath: options.helperPath })
  if (response.ok === true) {
    const rows = response.rows ?? []
    if (rows.length === 0) return { ok: true, text: `No history sessions${query ? ` matching "${query}"` : ''}.`, rows }
    const lines = rows.map((row) => {
      const usage = row.used !== null && row.used !== undefined ? ` · ctx ${Math.round((row.used / 1000))}K/${Math.round(((row.size ?? 0) / 1000))}K` : ''
      return `- ${describeSession(row)}${usage}\n  title: ${row.custom_title || row.title || '(untitled)'}\n  cwd: ${row.cwd ?? '-'} · updated ${toIso(row.last_activity_at) ?? '-'}`
    })
    return { ok: true, text: `${rows.length} session(s):\n${lines.join('\n')}`, rows }
  }
  // Database unavailable: fall back to the sidebar cards the window shows.
  await ready(options)
  const cards = await withWindow(options.port, 'main', (connection) => dom.readState(connection).then(() =>
    connection.evaluate(`(() => Array.from(document.querySelectorAll('div.cb-agent-card')).map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()))()`),
  ))
  return { ok: false, text: `Session database unreadable (${response.error}); sidebar shows:\n${cards.map((card) => `- ${card}`).join('\n')}`, rows: [] }
}

/** Live model catalogue from the window's own dropdown. */
export async function models(options) {
  await ready(options)
  const info = await withWindow(options.port, 'main', (connection) => dom.readModelMenu(connection))
  const lines = info.items.map((item) => {
    const flags = [item.badge, item.credits, item.selected ? 'selected' : undefined].filter(Boolean).join(' · ')
    return `- ${item.name}${flags ? ` (${flags})` : ''}`
  })
  return { ok: true, text: `Models offered by WorkBuddy:\n${lines.join('\n')}`, models: info.items }
}

/** Live expert marketplace listing. */
export async function experts(options, { query } = {}) {
  await ready(options)
  const info = await withWindow(options.port, 'main', (connection) => dom.readExperts(connection, { query }))
  const lines = info.experts.map((entry) => `- ${entry.name || '(未命名)'} — ${entry.role || 'role unknown'}${entry.canSummon ? '' : ' (不可召唤)'}`)
  return { ok: true, text: `${info.experts.length}/${info.total} expert(s):\n${lines.join('\n')}`, experts: info.experts }
}

/** Open a history session (by id or by its sidebar title) or a brand new task. */
export async function open(options, { session = 'new' } = {}) {
  await ready(options)
  if (session === 'new' || session === undefined || session === null) {
    await withWindow(options.port, 'main', (connection) => dom.openNewTask(connection))
    const state = await withWindow(options.port, 'main', (connection) => dom.readState(connection))
    return { ok: true, text: `Opened a new task (model ${state.model ?? '?'}).`, state }
  }
  const row = await resolveSession(options, session)
  if (row === undefined) return { ok: false, text: `No such history session: ${session}` }
  const title = row.custom_title || row.title
  if (!title) return { ok: false, text: `Session ${row.id} has no title to click in the sidebar.` }
  const opened = await withWindow(options.port, 'main', (connection) => dom.openSessionByTitle(connection, title))
  const state = await withWindow(options.port, 'main', (connection) => dom.readState(connection))
  return { ok: true, text: `Opened session ${String(row.id).slice(0, 8)} "${title}"${opened ? ` · header: ${opened}` : ''}.`, row, state }
}

/** Resolve a session argument (uuid, uuid prefix, or title fragment) to a row. */
export async function resolveSession(options, session) {
  if (session === undefined || session === null || session === '') return undefined
  const asText = String(session)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asText)) {
    const response = await store.getSession(asText, { dbPath: options.dbPath, helperPath: options.helperPath })
    return response.ok === true ? response.row ?? undefined : undefined
  }
  const byPrefix = await store.listSessions({ limit: 200, dbPath: options.dbPath, helperPath: options.helperPath })
  if (byPrefix.ok === true) {
    const rows = byPrefix.rows ?? []
    const hit = rows.find((row) => String(row.id).startsWith(asText))
      ?? rows.find((row) => `${row.custom_title ?? ''} ${row.title ?? ''}`.includes(asText))
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Apply model / effort / context / expert to the current composer or conversation. */
export async function configure(options, { model, effort, contextK, expert } = {}) {
  await ready(options)
  const applied = []
  return withWindow(options.port, 'main', async (connection) => {
    const before = await dom.readState(connection)
    const wantedModel = model ?? before.model
    if (model !== undefined) {
      const picked = await dom.selectModel(connection, model)
      applied.push(`model → ${picked.active ?? model}`)
    }
    if (effort !== undefined) {
      const result = await withRetry(() => dom.setEffort(connection, effort, { model: wantedModel }))
      applied.push(`effort → ${result.active ?? result.requested}${result.model ? ` (model ${result.model})` : ''}`)
    }
    if (expert !== undefined) {
      if (before.view === 'conversation') {
        applied.push(`expert skipped: "${expert}" (switching the expert inside an existing conversation is not wired yet; start a new task instead)`)
      } else {
        const result = await dom.summonExpert(connection, expert)
        applied.push(`expert → ${result.summoned}${result.chips.length > 0 ? ` (chip: ${result.chips.join(' | ')})` : ''}`)
      }
    }
    let context
    if (contextK !== undefined) {
      try {
        const result = await withRetry(() => dom.setContextWindow(connection, Number(contextK), { model: wantedModel }))
        context = result
        applied.push(`context → ${result.active ?? String(contextK) + 'K'}${result.previous && result.previous !== result.active ? ` (was ${result.previous})` : ''}`)
      } catch (error) {
        applied.push(`context skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let after = await dom.readState(connection)
    if (wantedModel !== undefined && after.model !== undefined && (after.model !== wantedModel && after.model.startsWith(wantedModel) === false)) {
      // Submenu interaction can slide the picker onto a neighbouring model.
      // Restore the requested one and say so instead of sending the task to the
      // wrong model.
      const restored = await dom.selectModel(connection, wantedModel)
      applied.push(`model restored → ${restored.active ?? wantedModel} (was ${after.model})`)
      after = await dom.readState(connection)
    }
    return {
      ok: true,
      text: [`Applied: ${applied.join('; ') || 'nothing'}`, `now: view=${after.view} model=${after.model ?? '?'}${after.chips.length > 0 ? ` chips=${after.chips.join(' | ')}` : ''}`].join('\n'),
      applied,
      state: after,
      context,
    }
  })
}

/** Type the task into the composer and submit it. */
export async function send(options, { task } = {}) {
  await ready(options)
  if (typeof task !== 'string' || task.trim().length === 0) throw new Error('task is empty')
  const startedAt = Date.now()
  const typed = await withWindow(options.port, 'main', async (connection) => {
    const state = await dom.readState(connection)
    const typedResult = await dom.typeTask(connection, task)
    return { view: state.view, ...typedResult }
  })
  await withWindow(options.port, 'main', (connection) => dom.sendComposer(connection))
  return { typed, startedAt }
}

/**
 * Find the session row a fresh send just created.
 *
 * `created_at >= since` is the precise filter, but it depends on the database
 * helper (a separate Node.js process) answering normally. When that lookup
 * fails we fall back to the newest rows without the time filter and keep the
 * first one created at or after the send, so a helper hiccup cannot lose a run
 * that WorkBuddy has already finished.
 */
async function adoptNewSession(options, since) {
  const dbOptions = { dbPath: options.dbPath, helperPath: options.helperPath }
  const recent = await store.sessionsSince(since - 3000, dbOptions)
  if (recent.ok === true && (recent.rows ?? []).length > 0) return { row: recent.rows[0], via: recent.via }
  const newest = await store.listSessions({ limit: 5, ...dbOptions })
  if (newest.ok === true) {
    const rows = (newest.rows ?? []).filter((row) => Number(row.created_at) >= since - 60000)
    if (rows.length > 0) {
      const best = rows.sort((left, right) => Number(right.created_at) - Number(left.created_at))[0]
      return { row: best, via: `${newest.via ?? 'list'} (fallback)` }
    }
  }
  return { row: undefined, error: recent.error ?? newest.error ?? 'no new session row' }
}

/** Poll until WorkBuddy reports the turn finished; return the answer text. */
export async function waitForRun(options, { sessionId, timeoutSec, since, onStep } = {}) {
  const budget = Number(timeoutSec) > 0 ? Number(timeoutSec) : options.waitTimeoutSec
  const deadline = Date.now() + budget * 1000
  let id = sessionId
  let last
  let poll = 0
  while (Date.now() < deadline) {
    poll += 1
    if (id === undefined && Number(since) > 0) {
      // A brand-new task may not have its row yet; adopt the newest row created
      // after the send so the database stays the source of truth.
      const adopted = await adoptNewSession(options, Number(since))
      if (adopted.row !== undefined) id = adopted.row.id
      else if (poll === 1) onStep?.(`waiting for the new session row: ${adopted.error ?? 'not written yet'}`)
    }
    if (id !== undefined) {
      const response = await store.getSession(id, { dbPath: options.dbPath, helperPath: options.helperPath })
      if (response.ok === true && response.row !== null && response.row !== undefined) last = response.row
      const status = response.ok === true ? response.row?.status : undefined
      if (status === 'completed' || status === 'error') {
        return { done: true, row: response.row, status, sessionId: id }
      }
      if (response.ok !== true) onStep?.(`db read failed: ${response.error ?? 'unknown error'}`)
    }
    // The database is authoritative here; the transcript/dom check below only
    // fills in rows whose status lags. Probe it on every fourth poll so a slow
    // or busy renderer cannot stall the wait.
    if (poll % 4 === 0) {
      try {
        const conversation = await withWindow(options.port, 'main', (connection) => dom.readConversation(connection))
        if (conversation.running !== true && conversation.sendDisabled === false && conversation.finished === true && conversation.lastAssistant.length > 0) {
          return { done: true, row: last, status: last?.status ?? 'completed', conversation }
        }
      } catch (error) {
        onStep?.(`conversation probe skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await sleep(2500)
  }
  const conversation = await withWindow(options.port, 'main', (connection) => dom.readConversation(connection))
  return { done: false, row: last, status: last?.status ?? 'unknown', conversation, sessionId: id }
}

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

function sameFile(left, right) {
  try {
    const a = fs.statSync(left)
    const b = fs.statSync(right)
    if (a.size !== b.size) return false
    return sha256(left) === sha256(right)
  } catch {
    return false
  }
}

/**
 * Collect what a finished session produced.
 *
 * WorkBuddy already writes its deliverables into the session workspace, so the
 * default is to report those absolute paths and copy nothing. An explicit
 * `outputDir` copies only files that are not already there with identical
 * content, and always reports the original location alongside the copy.
 */
export async function collect(options, { sessionId, outputDir, mode = 'auto', since } = {}) {
  // Accept a full uuid, a uuid prefix, or a title fragment — the same forms the
  // other tools take — so `collect` works with whatever the caller remembers.
  const row = await resolveSession(options, sessionId)
  const id = row?.id ?? sessionId
  const cwd = row?.cwd
  const transcript = id === undefined ? undefined : store.readTranscript(id, cwd)
  const workspaceFiles = typeof cwd === 'string' && fs.existsSync(cwd) ? store.listFiles(cwd) : []
  const cutoff = Number(since) > 0 ? Number(since) : undefined
  const recent = cutoff === undefined ? workspaceFiles : workspaceFiles.filter((file) => file.mtimeMs >= cutoff - 2000)

  const referenced = (transcript?.files ?? []).filter((file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  })

  const seen = new Set()
  const originals = []
  for (const file of [...recent.map((entry) => ({ path: entry.path, size: entry.size })), ...referenced.map((file) => ({ path: file, size: undefined }))]) {
    const key = path.resolve(file.path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    originals.push(file)
  }

  const lines = []
  const copies = []
  lines.push(`session: ${id ?? '(unknown)'} ${row ? `· status=${row.status} · model=${row.model ?? '?'} · ctx=${row.context_window ?? '-'} · effort=${row.thought_level ?? '-'}` : ''}`)
  if (cwd) lines.push(`workspace: ${cwd}`)
  if (transcript?.lastAssistant) lines.push(`last answer:\n${transcript.lastAssistant.slice(-2000)}`)
  if (originals.length === 0) {
    lines.push('files: none — this turn produced no files.')
  } else {
    lines.push(`files (${originals.length}) already written by WorkBuddy:`)
    for (const file of originals) lines.push(`- ${file.path}`)
  }

  const wantsCopy = mode === 'copy' && typeof outputDir === 'string' && outputDir.trim().length > 0 && cwd !== undefined
    && path.resolve(outputDir) !== path.resolve(cwd)
  if (wantsCopy && originals.length > 0) {
    fs.mkdirSync(outputDir, { recursive: true })
    for (const file of originals) {
      const target = path.join(outputDir, path.basename(file.path))
      if (sameFile(file.path, target)) {
        copies.push({ from: file.path, to: target, skipped: 'identical copy already present' })
        continue
      }
      try {
        fs.copyFileSync(file.path, target)
        copies.push({ from: file.path, to: target })
      } catch (error) {
        copies.push({ from: file.path, to: target, error: error instanceof Error ? error.message : String(error) })
      }
    }
    lines.push(`copied into ${outputDir}:`)
    for (const copy of copies) lines.push(`- ${copy.to}${copy.error ? ` (failed: ${copy.error})` : copy.skipped ? ` (skipped: ${copy.skipped})` : ''}`)
  } else if (originals.length > 0) {
    lines.push('note: files stay where WorkBuddy wrote them; pass mode:"copy" to duplicate them into outputDir.')
  }

  if (typeof outputDir === 'string' && outputDir.trim().length > 0 && transcript?.lastAssistant) {
    fs.mkdirSync(outputDir, { recursive: true })
    const summaryPath = path.join(outputDir, `workbuddy-result-${String(id ?? 'session').slice(0, 8)}.md`)
    const summary = [
      `# WorkBuddy result`,
      '',
      `- session: ${id ?? 'unknown'}`,
      `- title: ${row?.custom_title || row?.title || transcript?.title || 'unknown'}`,
      `- model: ${row?.model ?? 'unknown'} · context ${row?.context_window ?? '-'} · effort ${row?.thought_level ?? '-'}`,
      `- status: ${row?.status ?? 'unknown'}`,
      `- workspace: ${cwd ?? 'unknown'}`,
      '',
      '## Answer',
      '',
      transcript.lastAssistant,
      '',
      '## Files',
      '',
      ...(originals.length === 0 ? ['(none)'] : originals.map((file) => `- ${file.path}`)),
      '',
    ].join('\n')
    fs.writeFileSync(summaryPath, summary, 'utf8')
    lines.push(`summary: ${summaryPath}`)
  }

  return { ok: true, text: lines.join('\n'), originals: originals.map((file) => file.path), copies, cwd }
}

/** One-shot pipeline: open → configure → send → wait → collect. */
export async function run(options, args = {}) {
  const {
    task, session = 'new', model, effort, contextK, expert, outputDir, timeoutSec, mode = 'auto', restart = false,
  } = args
  if (typeof task !== 'string' || task.trim().length === 0) {
    return { ok: false, text: 'task is empty: nothing to hand to WorkBuddy.' }
  }
  const trace = []
  const step = (line) => {
    trace.push(line)
    if (process.env.WB_DEBUG === '1') process.stderr.write(`[wb] ${line}\n`)
  }
  await ensureRunning({ port: options.port, launchTimeoutMs: options.launchTimeoutMs, appPath: options.appPath, tools: options.tools, restart, autoRestart: options.autoRestart, dbPath: options.dbPath })
  step('app ready')

  let row
  if (session === 'new') {
    await withWindow(options.port, 'main', (connection) => dom.openNewTask(connection))
    step('opened new task')
  } else {
    row = await resolveSession(options, session)
    if (row === undefined) return { ok: false, text: `No such history session: ${session}` }
    const title = row.custom_title || row.title
    if (!title) return { ok: false, text: `Session ${row.id} has no clickable title.` }
    await withWindow(options.port, 'main', (connection) => dom.openSessionByTitle(connection, title))
    step(`opened session ${String(row.id).slice(0, 8)} "${title}"`)
  }

  const stateBefore = await withWindow(options.port, 'main', (connection) => dom.readState(connection))
  if (model !== undefined) {
    await withWindow(options.port, 'main', (connection) => dom.selectModel(connection, model))
    step(`model → ${model}`)
  }
  if (effort !== undefined) {
    try {
      const result = await withRetry(() => withWindow(options.port, 'main', (connection) => dom.setEffort(connection, effort, { model: model ?? stateBefore.model })))
      step(`effort → ${result.active ?? result.requested}`)
    } catch (error) {
      step(`effort failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (expert !== undefined) {
    if (stateBefore.view === 'conversation') {
      step(`expert "${expert}" not applied: the expert can only be chosen for a new task`)
    } else {
      try {
        const result = await withWindow(options.port, 'main', (connection) => dom.summonExpert(connection, expert))
        step(`expert → ${result.summoned}${result.chips.length > 0 ? ` (${result.chips.join(' | ')})` : ''}`)
      } catch (error) {
        step(`expert failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  let contextNote
  if (contextK !== undefined) {
    try {
      const result = await withRetry(() => withWindow(options.port, 'main', (connection) => dom.setContextWindow(connection, Number(contextK), { model: model ?? stateBefore.model })), 3)
      contextNote = `context → ${result.active ?? `${String(contextK)}K`}`
    } catch (error) {
      contextNote = `context deferred: ${error instanceof Error ? error.message : String(error)}`
    }
    step(contextNote)
  }

  // Keep the requested model: submenu interaction can slide the picker onto a
  // neighbouring row, and the task would then run on the wrong model.
  if (model !== undefined) {
    const stateNow = await withWindow(options.port, 'main', (connection) => dom.readState(connection))
    if (stateNow.model !== undefined && stateNow.model !== model && stateNow.model.startsWith(model) === false) {
      const restored = await withWindow(options.port, 'main', (connection) => dom.selectModel(connection, model))
      step(`model restored → ${restored.active ?? model} (was ${stateNow.model})`)
    }
  }

  const typed = await withWindow(options.port, 'main', async (connection) => {
    const typedResult = await dom.typeTask(connection, task)
    return typedResult
  })
  if (typed.sendDisabled === true) {
    return { ok: false, text: `Composer still looks empty after typing; nothing was sent.\ntrace:\n- ${trace.join('\n- ')}` }
  }
  const sendAt = Date.now()
  await withWindow(options.port, 'main', (connection) => dom.sendComposer(connection))
  step('sent')

  let sessionId = row?.id
  const identifyDeadline = Date.now() + 20000
  let identifyError
  while (sessionId === undefined && Date.now() < identifyDeadline) {
    const adopted = await adoptNewSession(options, sendAt)
    if (adopted.row !== undefined) {
      sessionId = adopted.row.id
      step(`session ${String(sessionId).slice(0, 8)} started (${adopted.row.status})`)
      break
    }
    identifyError = adopted.error
    await sleep(700)
  }
  if (sessionId === undefined) step(`session id not observed in the database yet${identifyError ? `: ${identifyError}` : ''}`)

  if (contextK !== undefined && contextNote?.startsWith('context deferred') === true) {
    try {
      const result = await withRetry(() => withWindow(options.port, 'main', (connection) => dom.setContextWindow(connection, Number(contextK))), 3)
      step(`context → ${result.active ?? `${String(contextK)}K`} (applied inside the conversation)`)
    } catch (error) {
      step(`context failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const settled = await waitForRun(options, { sessionId, timeoutSec, since: sendAt, onStep: step })
  if (sessionId === undefined && settled.sessionId !== undefined) sessionId = settled.sessionId
  step(`run ${settled.done ? 'finished' : 'timed out'} (status ${settled.status})`)

  const collected = await collect(options, { sessionId, outputDir, mode, since: sendAt })
  const header = [
    `WorkBuddy task ${settled.done ? 'finished' : 'still running'} — ${settled.status}`,
    sessionId ? `session: ${sessionId}` : undefined,
    row ? `resumed from: ${String(row.id).slice(0, 8)} "${row.custom_title || row.title}"` : undefined,
    `trace:\n- ${trace.join('\n- ')}`,
  ].filter(Boolean).join('\n')
  return {
    ok: settled.done === true && settled.status !== 'error',
    text: `${header}\n\n${collected.text}`,
    sessionId,
    status: settled.status,
    done: settled.done,
    originals: collected.originals,
    copies: collected.copies,
    trace,
  }
}
