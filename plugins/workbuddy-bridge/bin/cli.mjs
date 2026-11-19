#!/usr/bin/env node
import fs from 'node:fs'
import { createBridge, loadConfig } from '../index.js'
import { DB_PATH, findExecutable } from '../lib/paths.js'
const help = 'Usage: node bin/cli.mjs tools | doctor | call <workbuddy_tool> <JSON arguments>\nUse node bin/mcp.mjs for MCP stdio.'
try {
  const config = loadConfig()
  const [command, name, raw = '{}', ...extra] = process.argv.slice(2)
  if (!command || command === '--help' || command === 'help') { console.log(help) }
  else if (command === 'doctor') {
    console.log(JSON.stringify({ ok: true, node: process.version, platform: process.platform, executable: findExecutable(config.appPath) ?? null, databaseExists: fs.existsSync(config.dbPath ?? DB_PATH), port: config.port ?? 9222, autoRestart: config.autoRestart === true, action: 'observation only; app not launched or restarted' }, null, 2))
  } else if (command === 'tools') { console.log(JSON.stringify(createBridge(config).listTools(), null, 2)) }
  else if (command === 'call' && name && !extra.length) {
    const result = await createBridge(config).callTool(name, JSON.parse(raw))
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
  } else { throw new Error(help) }
} catch (error) { console.log(JSON.stringify({ ok: false, code: error.code ?? 'INVALID_ARGUMENT', text: error.message })); process.exitCode = 1 }
