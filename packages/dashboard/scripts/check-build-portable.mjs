// Guards the assumption `withBasePath()` relies on: apart from the route manifest, the
// client build holds no absolute asset URL, so it can be served under any base path.
//
// Two things could break that. A chunk could embed an absolute `/assets/...` URL, or a
// dynamic import could gain preload dependencies, which Vite resolves against the base
// baked at build time. Run after `npm run build`.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const assetsDir = new URL('../build/client/assets/', import.meta.url).pathname
const problems = []

for (const file of await readdir(assetsDir)) {
  if (!file.endsWith('.js') || file.startsWith('manifest-')) continue

  const source = await readFile(join(assetsDir, file), 'utf8')

  if (/["'`]\/assets\//.test(source)) {
    problems.push(`${file}: embeds an absolute /assets/ URL`)
  }

  // Vite wraps a dynamic import as `preload(() => import(x), [deps])` and fetches a
  // non-empty deps list from the build-time base. Today every list is empty.
  if (/import\([^()]*\)\s*,\s*\[\s*[^\]\s]/.test(source)) {
    problems.push(`${file}: a dynamic import has preload dependencies`)
  }
}

if (problems.length > 0) {
  console.error('The client build is no longer portable across base paths:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('See app/lib/runtime-base-path.ts.')
  process.exit(1)
}

console.log('client build is portable across base paths')
