import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as flow from './lib/flow.js'
import { withLock } from './lib/lock.js'
import { existingRequest, taskHash } from './lib/dispatch.js'

const str = (description) => ({ type: 'string', minLength: 1, description })
const num = (description, minimum = 0, maximum = 3600) => ({ type: 'number', minimum, maximum, description })
const session = str('Exact session id, unambiguous id prefix/title, or new. Historical operations verify the selected session.')
const settings = {
  model: str('Model display name from workbuddy_models.'),
  effort: { type: 'string', enum: ['关闭', '低', '中', '高', '超高'] },
  contextK: num('Context K offered by the selected model; 0 means its maximum.', 0, 100000),
  expert: str('Expert display name. New tasks only; unsupported configuration fails before sending.'),
}
const collection = {
  outputDir: str('Absolute folder for an optional summary; files stay at their source unless mode is copy.'),
  mode: { type: 'string', enum: ['auto', 'copy'], default: 'auto' },
  allowedOutputDirs: { type: 'array', items: { type: 'string' }, description: 'Explicit source output directories. Required for copy; files outside these roots are not copied.' },
}
function tool(name, description, properties, required = [], readOnlyHint = false) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { readOnlyHint, destructiveHint: !['workbuddy_sessions','workbuddy_wait','workbuddy_recover','workbuddy_collect'].includes(name), idempotentHint: readOnlyHint, openWorldHint: name === 'workbuddy_run' || name === 'workbuddy_send' } }
}
const catalogue = [
  tool('workbuddy_status', 'Observe with launch=false (default). launch=true starts the app; a running app with no debug port is forcibly relaunched under the configured user policy.', { launch: { type: 'boolean', default: false }, restart: { type: 'boolean', default: false } }),
  tool('workbuddy_sessions', 'Read WorkBuddy session metadata from its SQLite database without starting the app.', { query: str('Title filter.'), limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } }, [], true),
  tool('workbuddy_models', 'Read the live model menu. Opens the menu in the local WorkBuddy window.', {}),
  tool('workbuddy_experts', 'Read the live expert market in the local WorkBuddy window.', { query: str('Name or role filter.') }),
  tool('workbuddy_open', 'Open an unambiguous historical session or the new-task view. Prefer workbuddy_run for an atomic complete workflow.', { session }),
  tool('workbuddy_configure', 'Open the explicit target and configure it. Explicitly requested settings must succeed.', { session, ...settings }, ['session']),
  tool('workbuddy_send', 'Submit once with a durable dispatch ticket. Use requestId for retry deduplication; pending-observation means recover, not resend.', { session, task: str('Authorized task to execute in WorkBuddy.'), requestId: str('Caller retry key. Reusing it never sends another copy of the same task.'), waitSeconds: num('Optional completion wait. Zero returns the dispatch ticket.') }, ['session', 'task']),
  tool('workbuddy_wait', 'Wait for a dispatchId or explicit session. Default budget 30 seconds; waiting is not failure and never cancels the task.', { dispatchId: str('Durable dispatch id.'), sessionId: str('Target session id/prefix/title.'), timeoutSec: num('Wait budget in seconds.', 0.1), evidence: { type: 'object', description: 'Original evidence; prefer dispatchId so callers cannot accidentally rewrite it.' } }),
  tool('workbuddy_recover', 'Recover/bind an existing dispatch to its verified session and user turn. Never sends a message. Legacy 2.0 evidence can be explicitly imported after transcript validation.', { dispatchId: str('Durable dispatch id.'), sessionId: str('Optional recovered exact session id.'), evidence: { type: 'object', description: 'Original 2.0 failed-send evidence, only for legacy import.' } }),
  tool('workbuddy_cancel', 'Interrupt only a verified dispatch on its exact session and user turn; never kills the app. Returns requested and confirmed separately.', { dispatchId: str('Dispatch to interrupt.') }, ['dispatchId']),
  tool('workbuddy_collect', 'Read answer and candidate file paths for an explicit session; optionally write a summary or copy files without overwriting collisions.', { sessionId: str('Target session id/prefix/title.'), ...collection, sinceMs: num('Optional timestamp lower bound for modified-file candidates.', 0, Number.MAX_SAFE_INTEGER) }, ['sessionId']),
  tool('workbuddy_run', 'Open/configure/send once with a durable ticket, then wait up to 30s by default. Use recover/wait/cancel with its dispatchId. Missing CDP port triggers an authorized forced relaunch by default.', { task: str('Authorized task to execute in WorkBuddy.'), requestId: str('Stable caller retry key.'), session, ...settings, ...collection, timeoutSec: num('Wait budget in seconds.', 0.1), restart: { type: 'boolean', default: false } }, ['task']),
]

export function loadConfig(env = process.env) {
  const config = env.WORKBUDDY_BRIDGE_CONFIG ? JSON.parse(fs.readFileSync(env.WORKBUDDY_BRIDGE_CONFIG, 'utf8')) : {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid('configuration must be an object')
  if (env.WORKBUDDY_CDP_PORT) config.port = Number(env.WORKBUDDY_CDP_PORT)
  if (env.WORKBUDDY_DB) config.dbPath = env.WORKBUDDY_DB
  if (env.WORKBUDDY_EXE) config.appPath = env.WORKBUDDY_EXE
  if (env.WORKBUDDY_BRIDGE_LOCK) config.lockPath = env.WORKBUDDY_BRIDGE_LOCK
  return config
}

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }) }
export function validateArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('arguments must be an object')
  for (const key of schema.required ?? []) if (args[key] === undefined) throw invalid(`${key} is required`)
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key]
    if (!rule) throw invalid(`Unknown argument: ${key}`)
    const correctType = rule.type === 'array' ? Array.isArray(value) && value.every(v=>typeof v==='string' && path.isAbsolute(v)) : rule.type === 'integer' ? Number.isInteger(value) : rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === rule.type
    if (!correctType || typeof value === 'number' && !Number.isFinite(value)) throw invalid(`${key} must be ${rule.type}`)
    if (typeof value === 'string' && rule.minLength && !value.trim()) throw invalid(`${key} must not be empty`)
    if (rule.enum && !rule.enum.includes(value)) throw invalid(`${key} must be one of ${rule.enum.join(', ')}`)
    if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) throw invalid(`${key} is out of range`)
  }
  if (args.outputDir && !path.isAbsolute(args.outputDir)) throw invalid('outputDir must be absolute')
  if (args.mode === 'copy' && !args.outputDir) throw invalid('mode copy requires outputDir')
  if (args.mode === 'copy' && !args.allowedOutputDirs?.length) throw invalid('copy requires explicit allowedOutputDirs source roots')
  if (args.restart && args.launch === false) throw invalid('restart requires launch=true')
}

export function createBridge(config = {}) {
  if (config.port !== undefined && (!Number.isInteger(Number(config.port)) || Number(config.port) < 1 || Number(config.port) > 65535)) throw invalid('port must be between 1 and 65535')
  const runtime = flow.resolveOptions({ ...config, autoRestart: config.autoRestart !== false })
  if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) throw invalid('port must be between 1 and 65535')
  const lockPath = config.lockPath ?? path.join(process.env.WORKBUDDY_HOME ?? path.join(os.homedir(), '.workbuddy'), 'bridge-locks', `cdp-${runtime.port}.lock`)
  return {
    listTools: () => structuredClone(catalogue),
    async callTool(name, args = {}) {
      let lastDispatch = args.dispatchId ? {dispatchId:args.dispatchId,sessionId:args.sessionId} : undefined
      try {
        const definition = catalogue.find(t => t.name === name)
        if (!definition) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'UNKNOWN_TOOL' })
        validateArguments(definition.inputSchema, args)
        if (name === 'workbuddy_wait' && !args.dispatchId && !args.sessionId) throw invalid('dispatchId or sessionId is required')
        const execute = async () => {
          if (['workbuddy_run','workbuddy_send'].includes(name) && args.requestId) {
            const prior = existingRequest(runtime, args.requestId)
            if (prior) {
              if (prior.taskHash !== taskHash(args.task)) throw Object.assign(new Error('requestId already belongs to another task.'), { code: 'REQUEST_CONFLICT' })
              return flow.recover(runtime, { dispatchId: prior.dispatchId })
            }
          }
          let result
          switch (name) {
            case 'workbuddy_status': result = await flow.status(runtime, { launch: args.launch === true || args.restart === true, restart: args.restart === true }); break
            case 'workbuddy_sessions': result = await flow.history(runtime, args); break
            case 'workbuddy_models': result = await flow.models(runtime); break
            case 'workbuddy_experts': result = await flow.experts(runtime, args); break
            case 'workbuddy_open': result = await flow.open(runtime, args); break
            case 'workbuddy_configure': {
              const opened = await flow.open(runtime, { session: args.session })
              if (!opened.ok) throw new Error(opened.text ?? 'Could not open the target session')
              result = await flow.configure(runtime, args); break
            }
            case 'workbuddy_send': {
              const opened = await flow.open(runtime, { session: args.session })
              if (!opened.ok) throw new Error(opened.text ?? 'Could not open the target session')
              const sent = await flow.send(runtime, { task: args.task, sessionId: opened.row?.id ?? opened.sessionId, requestId: args.requestId })
              lastDispatch = {dispatchId:sent.dispatchId,sessionId:sent.sessionId,evidence:sent.evidence,submitted:sent.ok}
              result = { ok: true, text: `Task submitted. Session: ${sent.sessionId ?? '(not yet observed)'}.`, ...sent }
              if (!sent.ok || sent.needsRecovery) break
              if (args.waitSeconds > 0) {
                const waited = await flow.waitForRun(runtime, { sessionId: sent.sessionId, since: sent.startedAt, evidence: sent.evidence, timeoutSec: args.waitSeconds })
                result = { ...result, ok: waited.done && waited.status === 'completed', text: `${result.text}\n${waited.done ? waited.status : 'timeout; task may still be running'}`, waited }
              }
              break
            }
            case 'workbuddy_wait': {
              const waited = await flow.waitForRun(runtime, args)
              if (!waited.done) { result = { ok: true, status: waited.needsRecovery ? 'pending-observation' : 'waiting', done: false, text: 'Wait budget elapsed; task is not cancelled. Continue with the dispatch ticket.', waited, sessionId: waited.sessionId, dispatchId: args.dispatchId ?? args.evidence?.dispatchId, evidence: args.evidence }; break }
              const collected = await flow.collect(runtime, { sessionId: waited.sessionId, since: args.evidence?.since, answer: args.evidence || args.dispatchId ? waited.turn.answer ?? '' : undefined })
              result = { ok: waited.done && waited.status === 'completed', text: `${waited.done ? waited.status : 'timeout; task may still be running'}\n${collected.text}`, waited, collected }; break
            }
            case 'workbuddy_recover': result = await flow.recover(runtime, args); break
            case 'workbuddy_cancel': result = await flow.cancel(runtime, args); break
            case 'workbuddy_collect': result = await flow.collect(runtime, { ...args, since: args.sinceMs }); break
            case 'workbuddy_run': result = await flow.run(runtime, args); break
          }
          return result
        }
        // Read/observe operations do not queue behind a long run. A separately guarded
        // cancel can reach the stop control while that run is only polling SQLite.
        if (name === 'workbuddy_cancel') return await withLock(`${lockPath}.cancel`, execute)
        if (['workbuddy_sessions','workbuddy_wait','workbuddy_collect','workbuddy_recover'].includes(name)) return await execute()
        return await withLock(lockPath, execute)
      } catch (error) {
        return { ...lastDispatch, ok: false, code: error.code ?? 'BRIDGE_ERROR', text: error.message ?? String(error), details: error.details }
      }
    },
  }
}
