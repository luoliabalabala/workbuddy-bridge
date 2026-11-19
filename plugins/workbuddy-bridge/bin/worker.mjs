import { createBridge, loadConfig } from '../index.js'

const bridge = createBridge({ ...loadConfig(), callerContextSource: 'mcp' })
process.on('message', async ({ id, name, args, context }) => {
  let response
  try { response = { id, result: await bridge.callTool(name, args, context) } }
  catch (error) { response = { id, error: error.message } }
  if (process.connected) process.send(response, () => {})
})
