/**
 * Save a PNG of the WorkBuddy window over CDP, so a headless check can still
 * see what the renderer shows.
 *
 * node scripts/grab.mjs [outFile]
 */
import fs from 'node:fs'
import { withWindow } from '../src/lib/cdp.js'

const out = process.argv[2] ?? 'tmp/workbuddy.png'
const png = await withWindow(9222, 'main', (connection) => connection.screenshot())
fs.writeFileSync(out, png)
console.log(`${out} (${png.length} bytes)`)
