import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cjsOutput = './dist/index.cjs'

// This wrapper re-exports the default export cleanly to require().
const cjsWrapper = `
// Auto-generated cjs wrapper for require(esm) for Node 22.12 and higher
module.exports = require("./index.mjs").default;
`

writeFileSync(path.resolve(__dirname, '..', cjsOutput), cjsWrapper.trimStart())
console.log(`✅ Created CJS wrapper: ${cjsOutput}`)
