/**
 * WorkBuddy bridge — a Host plugin that drives Codework's WorkBuddy desktop app
 * through computer use and hands WhatsApp-grade results back to the agent.
 *
 * Split of the job:
 *   - actions  → CDP over the app's own DevTools port (clicks, typing, sends);
 *   - reads    → the app's session database and per-session transcript log;
 *   - windows  → the installed computer-use server, when it is present.
 *
 * @module dsh-workbuddy-bridge
 */
import { sleep } from './lib/cdp.js'
import * as flow from './lib/flow.js'
import * as store from './lib/store.js'

export const inject = ['tools']

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the step succeeded.' },
    text: { type: 'string', description: 'Human and model readable report, including absolute file paths.' },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
}

const render = (args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]

const definition = (name, description, parameters, execute, { timeoutMs } = {}) => ({
  name,
  description,
  parameters: { type: 'object', properties: parameters, additionalProperties: false },
  output: { schema: OUTPUT_SCHEMA, render },
  execute,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
})

const PLUGIN_NAME = 'WorkBuddy 桥'

export function apply(ctx, config = {}) {
  const baseOptions = flow.resolveOptions({ ...config, tools: ctx.tools })
  const options = () => ({ ...baseOptions, tools: ctx.tools })

  const register = (tool) => ctx.effect(() => ctx.tools.register(tool))

  register(definition(
    'workbuddy_status',
    '检查 WorkBuddy 是否在运行并可通过 computer use 操控，报告主窗口当前视图、模型、上下文与专家；未运行时会带上 --remote-debugging-port 启动它。',
    {
      restart: { type: 'boolean', description: '强制关闭所有 WorkBuddy 窗口并重新带调试端口启动。平时不需要：应用没带调试端口时插件会自动重启它。' },
      launch: { type: 'boolean', description: '是否在需要时启动应用，默认 true。' },
    },
    async (args = {}) => {
      const result = await flow.status(options(), { restart: args.restart === true, launch: args.launch !== false })
      return { ok: result.ok === true, text: result.text }
    },
  ))

  register(definition(
    'workbuddy_sessions',
    '列出 WorkBuddy 的历史会话（来自应用自己的数据库），可用于挑选要接管的会话：返回 id、标题、状态、模型、专家、上下文长度、思考强度与工作目录。',
    {
      query: { type: 'string', description: '按标题关键字过滤。' },
      limit: { type: 'number', description: '最多返回多少条，默认 20。' },
    },
    async (args = {}) => {
      const result = await flow.history(options(), { query: args.query, limit: Number(args.limit) || 20 })
      return { ok: result.ok === true, text: result.text }
    },
  ))

  register(definition(
    'workbuddy_models',
    '读取 WorkBuddy 模型下拉里可选的模型型号、倍率与当前选中的型号（实时读取界面，不写死名单）。',
    {},
    async () => {
      const result = await flow.models(options())
      return { ok: true, text: result.text }
    },
  ))

  register(definition(
    'workbuddy_experts',
    '读取 WorkBuddy 专家列表：专家名、对应角色、是否可召唤，用于挑选要投递任务的专家。',
    { query: { type: 'string', description: '按专家名/角色/描述关键字过滤。' } },
    async (args = {}) => {
      const result = await flow.experts(options(), { query: args.query })
      return { ok: true, text: result.text }
    },
  ))

  register(definition(
    'workbuddy_open',
    '在 WorkBuddy 里打开一个历史会话（传 id、id 前缀或标题片段），或传 "new" 新建任务会话，返回当前视图状态。',
    { session: { type: 'string', description: '会话 id / id 前缀 / 标题片段，或 "new"。默认 "new"。' } },
    async (args = {}) => {
      const result = await flow.open(options(), { session: args.session ?? 'new' })
      return { ok: result.ok === true, text: result.text }
    },
  ))

  register(definition(
    'workbuddy_configure',
    '设置模型型号、思考强度、上下文长度与专家：模型/思考强度/上下文长度都来自输入框右侧的模型下拉二级面板（新建任务和会话内都可用），专家在专家列表里召唤（仅新建任务）。',
    {
      model: { type: 'string', description: '模型显示名，例如 "Hy4"、"DeepSeek-V4.1-Flash"、"claude-opus-5-5"。' },
      effort: { type: 'string', description: '思考强度：关闭 / 低 / 中 / 高 / 超高。' },
      contextK: { type: 'number', description: '上下文长度（K）：不同模型可选 300 / 600 / 960 / 1000（1M）；超出该模型最大档时自动取最大档，0 也表示最大档。' },
      expert: { type: 'string', description: '专家名，例如 "吴八哥"；仅在新建任务时生效。' },
    },
    async (args = {}) => {
      const result = await flow.configure(options(), {
        model: args.model,
        effort: args.effort,
        contextK: args.contextK,
        expert: args.expert,
      })
      return { ok: true, text: result.text }
    },
  ))

  register(definition(
    'workbuddy_send',
    '把任务文本粘贴进 WorkBuddy 输入框并点击发送（会先清空输入框里的预填内容），随后识别新建的会话 id；可选等待它跑完。',
    {
      task: { type: 'string', description: '要交给 WorkBuddy 执行的完整任务文本。' },
      waitSeconds: { type: 'number', description: '发送后最多等待多少秒让任务跑完，0 表示发送后立即返回（默认 0）。' },
    },
    async (args = {}, exec) => {
      if (typeof args?.task !== 'string' || args.task.trim().length === 0) throw new Error('task is required')
      const runtime = options()
      const sent = await flow.send(runtime, { task: args.task })
      let sessionId
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && sessionId === undefined) {
        const recent = await store.sessionsSince(sent.startedAt - 3000, { dbPath: runtime.dbPath, helperPath: runtime.helperPath })
        if (recent.ok === true && (recent.rows ?? []).length > 0) sessionId = recent.rows[0].id
        else await sleep(700)
      }
      const lines = [
        `Task sent${sessionId ? ` · session ${sessionId}` : ' · session id not observed yet'}`,
        `composer text confirmed: ${String(sent.typed.text).slice(0, 120)}${String(sent.typed.text).length > 120 ? '…' : ''}`,
      ]
      const waitSeconds = Number(args.waitSeconds) || 0
      if (waitSeconds > 0) {
        const settled = await flow.waitForRun(runtime, { sessionId, timeoutSec: waitSeconds })
        const collected = await flow.collect(runtime, { sessionId, since: sent.startedAt })
        lines.push(`run ${settled.done ? 'finished' : 'timed out'} (status ${settled.status})`, '', collected.text)
      }
      return { ok: true, text: lines.join('\n') }
    },
    { timeoutMs: 1800000 },
  ))

  register(definition(
    'workbuddy_wait',
    '等待 WorkBuddy 会话跑完（按数据库状态与界面停止信号判断），返回状态、最后一条回答与产物文件路径。',
    {
      sessionId: { type: 'string', description: '要等待的会话 id；省略时按当前界面判断。' },
      timeoutSec: { type: 'number', description: '最长等待秒数，默认取插件配置（900）。' },
    },
    async (args = {}) => {
      const runtime = options()
      const settled = await flow.waitForRun(runtime, { sessionId: args.sessionId, timeoutSec: args.timeoutSec })
      const collected = await flow.collect(runtime, { sessionId: args.sessionId ?? settled.row?.id })
      return {
        ok: settled.done === true,
        text: [`run ${settled.done ? 'finished' : 'timed out'} (status ${settled.status ?? 'unknown'})`, '', collected.text].join('\n'),
      }
    },
    { timeoutMs: 1800000 },
  ))

  register(definition(
    'workbuddy_collect',
    '收集会话产物：WorkBuddy 已经把文件写在会话工作目录里，默认只回报绝对路径、不重复存储；给出 outputDir 时才复制（内容相同则跳过），并写一份结果摘要。',
    {
      sessionId: { type: 'string', description: '会话 id。' },
      outputDir: { type: 'string', description: '可选：把结果摘要（markdown）写进该文件夹；WorkBuddy 已产出的文件默认只回报原始路径。' },
      mode: { type: 'string', enum: ['auto', 'copy'], description: 'auto（默认）：只回报路径；copy：在给出 outputDir 时复制。' },
      sinceMs: { type: 'number', description: '可选：只收集该毫秒时间戳之后修改的文件。' },
    },
    async (args = {}) => {
      const result = await flow.collect(options(), {
        sessionId: args.sessionId,
        outputDir: args.outputDir,
        mode: args.mode ?? 'auto',
        since: Number(args.sinceMs) || undefined,
      })
      return { ok: true, text: result.text }
    },
  ))

  register(definition(
    'workbuddy_run',
    `一键把任务交给 WorkBuddy 并回收获产物：打开历史会话或新建会话 → 选模型/思考强度/上下文/专家 → 粘贴任务并发送 → 等它跑完 → 返回回答与文件路径（WorkBuddy 已写出的文件不重复存储；给了 outputDir 才复制）。

限制：专家只能在新建任务时选择，历史会话里换专家会被跳过并说明原因；上下文长度按模型给的可选档位，超出自动取最大档。`,
    {
      task: { type: 'string', description: '完整任务文本。' },
      session: { type: 'string', description: '历史会话 id / id 前缀 / 标题片段；"new" 表示新建任务（默认）。' },
      model: { type: 'string', description: '模型显示名。' },
      effort: { type: 'string', description: '思考强度：关闭/低/中/高/超高。' },
      contextK: { type: 'number', description: '上下文长度（K）：300 / 600 / 960 / 1000；超出模型最大档时自动取最大档，0 表示最大档。' },
      expert: { type: 'string', description: '专家名，仅在新建任务时生效。' },
      outputDir: { type: 'string', description: '可选：把结果摘要（markdown）写进该文件夹；产物默认只回报原始路径，mode:copy 才复制。' },
      mode: { type: 'string', enum: ['auto', 'copy'], description: '产物处理方式，默认 auto。' },
      timeoutSec: { type: 'number', description: '等待任务跑完的最长秒数。' },
      restart: { type: 'boolean', description: '强制重启 WorkBuddy。平时不需要：应用没带调试端口时插件会自动重启它（正在跑任务的会话不会被强杀）。' },
    },
    async (args = {}) => {
      const result = await flow.run(options(), args)
      return { ok: result.ok === true, text: result.text }
    },
    { timeoutMs: 3600000 },
  ))

  ctx.logger?.info?.(`${PLUGIN_NAME}: registered ${ctx.tools.definitions().filter((tool) => tool.name.startsWith('workbuddy_')).length} tools`)
}

export const name = 'workbuddy-bridge'
