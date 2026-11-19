/** Launch policy confirmed by the user: force relaunch a running app with no CDP port. */
import { spawn } from 'node:child_process'
import { debuggerVersion, sleep } from './cdp.js'
import { findExecutable } from './paths.js'
import { activeSessions } from './store.js'
import helperPath from './helper-path.js'

async function capture(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore','pipe','ignore'] })
    let text = ''
    let settled = false
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const timer = setTimeout(() => { child.kill(); done({ ok: false, text }) }, 8000)
    child.stdout.on('data', chunk => { text += chunk })
    child.on('error', e => done({ ok: false, text, error: e.message }))
    child.on('close', code => done({ ok: code === 0, text }))
  })
}
export async function isRunning() {
  const result = await capture('tasklist', ['/FI','IMAGENAME eq WorkBuddy.exe','/FO','CSV','/NH'])
  if (!result.ok) throw Object.assign(new Error('Could not inspect local WorkBuddy processes.'), { code: 'PROCESS_STATE_UNKNOWN' })
  return result.text.toLowerCase().includes('workbuddy.exe')
}
export function restartDecision({ endpointReachable, running, restart = false, autoRestart = true }) {
  if (endpointReachable && !restart) return 'reuse'
  if (running && !restart && !autoRestart) return 'needs-restart'
  return running ? 'force-restart' : 'launch'
}
export async function ensureRunning({ port, launchTimeoutMs = 30000, appPath, restart = false, autoRestart = true, dbPath }) {
  const version = await debuggerVersion(port)
  if (version && !restart) return { port, launched: false, restarted: false, version }
  const running = await isRunning()
  const decision = restartDecision({ endpointReachable: !!version, running, restart, autoRestart })
  if (decision === 'needs-restart') throw Object.assign(new Error('WorkBuddy is running without its debug port; autoRestart is explicitly disabled.'), { code: 'NEEDS_RESTART' })
  const exe = findExecutable(appPath)
  if (!exe) throw Object.assign(new Error('WorkBuddy executable not found.'), { code: 'NO_EXE' })
  const restartAudit = { requestedAt: Date.now(), reason: restart ? 'explicit-restart' : 'missing-debug-port', policy: 'force-on-missing-port', processWasRunning: running }
  if (running) {
    const busy = await activeSessions({ dbPath, helperPath })
    restartAudit.activeSessionCount = busy.ok ? busy.rows.length : null
    restartAudit.busyStateReadable = busy.ok
    // The user explicitly authorized interruption here. Do not silently block on stale or busy DB rows.
    const closed = await capture('taskkill', ['/F','/IM','WorkBuddy.exe'])
    if (!closed.ok && await isRunning()) throw Object.assign(new Error('Could not close WorkBuddy for the authorized relaunch.'), { code: 'RESTART_FAILED', details: restartAudit })
    const end = Date.now() + 8000
    while (await isRunning() && Date.now() < end) await sleep(300)
    if (await isRunning()) throw Object.assign(new Error('WorkBuddy is still running after close.'), { code: 'RESTART_FAILED' })
  }
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, windowsHide: true, stdio: 'ignore' })
  let launchError
  child.on('error', e => { launchError = e })
  child.unref()
  const end = Date.now() + launchTimeoutMs
  while (Date.now() < end) {
    if (launchError) throw launchError
    const ready = await debuggerVersion(port)
    if (ready) return { port, launched: true, restarted: running, how: 'spawn', version: ready, restartAudit: running ? restartAudit : undefined }
    await sleep(500)
  }
  throw Object.assign(new Error(`No debug port ${port} after launch; no automatic second kill was attempted.`), { code: 'NO_PORT', details: restartAudit })
}
