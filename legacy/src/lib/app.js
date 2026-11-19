/**
 * Making sure WorkBuddy is up and reachable over the DevTools port.
 *
 * WorkBuddy is a single-instance Electron app: whichever process starts first
 * owns the instance and a later launch with a debugging flag is silently
 * ignored. So the plugin cannot "add" the port to a running app — it has to
 * relaunch it, and that relaunch is done here automatically:
 *
 *   port answers            → use it
 *   running, no port        → close every window, start it again with the flag
 *   not running             → start it with the flag
 *
 * One guard exists for the user's sake: when the database says a turn is
 * running right now, killing the app would throw that work away, so the plugin
 * refuses and says which session is busy instead of force-restarting.
 */
import { spawn } from 'node:child_process'
import { debuggerVersion, sleep } from './cdp.js'
import { findExecutable } from './paths.js'
import * as store from './store.js'

const EXE_NAME = 'WorkBuddy.exe'
/** A turn that touched the database this recently is treated as still running. */
const LIVE_TURN_MS = 120000

function runCapture(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve({ ok: false, output: '' })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, output })
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ ok: true, output })
    })
  })
}

/** Whether a WorkBuddy.exe process exists at all. */
export async function isRunning() {
  const { output } = await runCapture('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'])
  return output.toLowerCase().includes(EXE_NAME.toLowerCase())
}

/** Ask the computer-use server to do a window-level action, when it is installed. */
export async function computerUse(tools, name, args, timeoutMs = 30000) {
  if (tools === undefined || typeof tools.execute !== 'function') return { ok: false, text: 'computer use tools unavailable' }
  const callName = `mcp__wincu__windows_computer_use_${name}`
  try {
    const batch = await tools.execute({
      calls: [{ type: 'tool-call', id: `wcu-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, name: callName, arguments: JSON.stringify(args ?? {}) }],
      signal: AbortSignal.timeout(timeoutMs),
    })
    const first = batch?.results?.[0]
    const text = (first?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    return { ok: first?.isError !== true, text }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

/** Force-close every WorkBuddy window so the next launch can bind the flag. */
async function forceClose(tools) {
  await computerUse(tools, 'close_window', { windowTitle: 'WorkBuddy' }, 15000)
  await sleep(1200)
  if (await isRunning()) {
    await runCapture('taskkill', ['/F', '/IM', EXE_NAME], 10000)
    await sleep(1500)
  }
  // Give the single-instance lock and the port time to be released.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if ((await isRunning()) === false) return
    await sleep(400)
  }
}

/** Launch with the debugging flag through the desktop shell, falling back to the exe. */
async function launch(tools, exe, port) {
  const viaComputerUse = await computerUse(tools, 'launch_app', { target: exe, arguments: `--remote-debugging-port=${port}` }, 20000)
  if (viaComputerUse.ok && viaComputerUse.text.toLowerCase().includes('error') === false) return 'computer-use'
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return 'spawn'
}

/** Wait for the DevTools endpoint to answer. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(600)
    const version = await debuggerVersion(port)
    if (version !== undefined) return version
  }
  return undefined
}

/** The session WorkBuddy is working on right now, if any. */
async function liveTurn(dbPath) {
  const response = await store.listSessions({ limit: 5, ...(dbPath === undefined ? {} : { dbPath }) })
  if (response.ok !== true) return undefined
  const now = Date.now()
  return (response.rows ?? []).find((row) => row.status === 'active' && Number(row.last_activity_at ?? 0) > now - LIVE_TURN_MS)
}

function needsRestartError(detail) {
  const error = new Error(detail)
  error.code = 'NEEDS_RESTART'
  return error
}

/**
 * Ensure the DevTools port answers, launching or relaunching the app as needed.
 *
 * @returns {Promise<{port:number, launched:boolean, restarted:boolean, how?:string, version:object}>}
 */
export async function ensureRunning({ port, launchTimeoutMs = 30000, appPath, tools, restart = false, autoRestart = true, dbPath }) {
  const existing = await debuggerVersion(port)
  if (existing !== undefined && restart !== true) {
    return { port, launched: false, restarted: false, version: existing }
  }

  let restarted = false
  if (existing !== undefined) {
    // Explicit `restart: true`: the port works but the caller wants a clean app.
    const busy = await liveTurn(dbPath)
    if (busy !== undefined) {
      throw needsRestartError(
        `WorkBuddy is still working on "${busy.custom_title || busy.title || busy.id}" — the restart was skipped so that task is not lost. `
        + 'Wait for it to finish, or close WorkBuddy yourself and call again.',
      )
    }
    await forceClose(tools)
    restarted = true
  } else if (await isRunning()) {
    // Running but unreachable: this is the single-instance case. Relaunching is
    // the only way to get a port, and it is what the caller asked for by using
    // any of these tools.
    if (autoRestart !== true) {
      throw needsRestartError(
        `WorkBuddy is running without a DevTools port on ${port}, and automatic restart is disabled `
        + '("autoRestart": false in the plugin config). Close it and call again.',
      )
    }
    const busy = await liveTurn(dbPath)
    if (busy !== undefined) {
      throw needsRestartError(
        `WorkBuddy is running without a DevTools port and is currently working on `
        + `"${busy.custom_title || busy.title || busy.id}" — restarting now would throw that turn away. `
        + 'Let it finish, then call again (the plugin will relaunch with the port automatically).',
      )
    }
    await forceClose(tools)
    restarted = true
  }

  const exe = findExecutable(appPath)
  if (exe === undefined) {
    const error = new Error('WorkBuddy.exe not found. Set the plugin config "appPath" to the executable.')
    error.code = 'NO_EXE'
    throw error
  }

  let how = await launch(tools, exe, port)
  let version = await waitForPort(port, launchTimeoutMs)
  if (version === undefined && (await isRunning())) {
    // A leftover process can swallow the flag (single-instance lock) — one more
    // clean relaunch usually binds the port.
    await forceClose(tools)
    restarted = true
    how = `${how} (retried once)`
    version = await waitForPort(port, launchTimeoutMs)
  }
  if (version === undefined) {
    const error = new Error(`WorkBuddy did not expose a DevTools port on ${port} within ${Math.round(launchTimeoutMs / 1000)}s (launched via ${how}).`)
    error.code = 'NO_PORT'
    throw error
  }
  return { port, launched: true, restarted, how, version }
}
