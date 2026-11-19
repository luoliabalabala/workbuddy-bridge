import { createBridge } from './index.js'
export const name = 'workbuddy-bridge'
export const inject = ['tools']
/** Optional legacy DSH host adapter; all behavior comes from the common layer. */
export function apply(ctx, config = {}) {
  const bridge = createBridge({ ...config, tools: ctx.tools })
  for (const tool of bridge.listTools()) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      timeoutMs: 3700000,
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args = {}) { const result = await bridge.callTool(tool.name, args); return { ok: result.ok === true, text: JSON.stringify(result) } },
    }))
  }
}
