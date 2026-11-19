/**
 * Development harness: exercise the plugin's own library outside the Harness,
 * so selectors and flows can be debugged with plain Node.js before installing.
 *
 * node scripts/try-lib.mjs status|sessions|models|experts|state|configure|run ...
 */
import * as flow from '../src/lib/flow.js'
import { withWindow } from '../src/lib/cdp.js'
import * as dom from '../src/lib/dom.js'

const options = flow.resolveOptions({})
const [command, ...rest] = process.argv.slice(2)

const bang = (value) => JSON.stringify(value, null, 2)

try {
  if (command === 'status') {
    console.log((await flow.status(options, {})).text)
  } else if (command === 'sessions') {
    console.log((await flow.history(options, { query: rest[0], limit: Number(rest[1]) || 8 })).text)
  } else if (command === 'models') {
    console.log((await flow.models(options)).text)
  } else if (command === 'experts') {
    console.log((await flow.experts(options, { query: rest[0] })).text)
  } else if (command === 'state') {
    console.log(bang(await withWindow(options.port, 'main', (connection) => dom.readState(connection))))
  } else if (command === 'conversation') {
    console.log(bang(await withWindow(options.port, 'main', (connection) => dom.readConversation(connection))))
  } else if (command === 'context') {
    console.log(bang(await withWindow(options.port, 'main', (connection) => dom.readContextWindow(connection))))
  } else if (command === 'open') {
    console.log((await flow.open(options, { session: rest[0] ?? 'new' })).text)
  } else if (command === 'configure') {
    const args = JSON.parse(rest[0] ?? '{}')
    console.log((await flow.configure(options, args)).text)
  } else if (command === 'type') {
    console.log(bang(await withWindow(options.port, 'main', (connection) => dom.typeTask(connection, rest.join(' ')))))
  } else if (command === 'run') {
    const args = JSON.parse(rest[0] ?? '{}')
    const result = await flow.run(options, args)
    console.log(result.text)
  } else if (command === 'collect') {
    const args = JSON.parse(rest[0] ?? '{}')
    console.log((await flow.collect(options, args)).text)
  } else {
    console.log('usage: try-lib.mjs <status|sessions|models|experts|state|conversation|context|open|configure|type|run|collect> [json]')
  }
} catch (error) {
  console.error('ERROR:', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
  process.exitCode = 1
}
