// withBasePath() assumes the client build holds no absolute asset URL outside the route
// manifest. Fails the build if a chunk embeds one, or if a dynamic import gains preload
// dependencies, which Vite fetches from the base baked at build time.
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

  // preload(() => import(x), [deps]): a non-empty list is fetched from the baked base.
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
