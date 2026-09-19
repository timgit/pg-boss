import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBasePath } from '../app/lib/base-path.ts'

/**
 * `withBasePath()` serves one build under any prefix by rewriting two things:
 * the router basename and the asset URLs inside the route manifest. That only
 * works while nothing *else* in the build has an absolute asset URL baked into
 * it, because nothing else gets rewritten.
 *
 * This fails the build when that stops being true.
 *
 * The prefix is derived from the same environment variable the build used,
 * rather than hardcoded as `/assets/`. Hardcoding it meant the check passed
 * vacuously on exactly the builds that need it: a build made with
 * `PGBOSS_DASHBOARD_BASE_PATH=/admin` puts its assets at `/admin/assets/`, which
 * the literal never matched, so the one configuration where portability matters
 * was the one going unchecked.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'build/client')
const { viteBase } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)
const assetPrefix = `${viteBase}assets/`

const problems: string[] = []

/** Every emitted file, not only `assets/*.js`. CSS embeds URLs too, and so can anything copied in. */
async function * walk (dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      yield * walk(path)
    } else {
      yield path
    }
  }
}

/**
 * A dynamic import with preload dependencies.
 *
 * Two spellings: the inline array a bundler emits directly, and Vite's
 * `__vite__mapDeps(...)` indirection, which holds the same list one level away.
 * Only the first was checked, and which one appears depends on the bundler and
 * its settings — so the check was one toolchain change away from passing on a
 * build it should reject.
 */
const PRELOAD_PATTERNS = [
  /import\([^()]*\)\s*,\s*\[\s*[^\]\s]/,
  /__vite__mapDeps\(\s*\[\s*[^\]\s]/,
]

for await (const path of walk(clientDir)) {
  const name = path.slice(clientDir.length + 1)
  const extension = extname(path)

  if (!['.js', '.mjs', '.css'].includes(extension)) {
    continue
  }

  // The manifest is the one file `withBasePath` does rewrite.
  if (/(^|\/)manifest-[^/]*\.js$/.test(name)) {
    continue
  }

  const source = await readFile(path, 'utf8')

  if (source.includes(assetPrefix)) {
    problems.push(`${name}: embeds the absolute asset URL ${assetPrefix}`)
  }

  if (extension !== '.css' && PRELOAD_PATTERNS.some((pattern) => pattern.test(source))) {
    problems.push(`${name}: a dynamic import has preload dependencies`)
  }
}

/**
 * The manifest has to be rewritable in full.
 *
 * `rehomeAssetUrls` walks strings in keys and values. Anything else carrying an
 * asset URL — a number-keyed structure, a URL embedded mid-string rather than at
 * its start — would survive the rewrite untouched and point at the old prefix.
 * Counting is enough to notice: if the rewritten copy still mentions the old
 * prefix anywhere, something was missed.
 */
const assetsDir = join(clientDir, 'assets')
const manifestName = (await readdir(assetsDir)).find((file) => file.startsWith('manifest-'))

if (!manifestName) {
  problems.push('no route manifest found in build/client/assets')
} else {
  const source = await readFile(join(assetsDir, manifestName), 'utf8')
  const embedded = source.split(assetPrefix).length - 1

  if (embedded === 0) {
    problems.push(
      `${manifestName}: no asset URLs found, so this check proves nothing — ` +
      'the prefix it looked for is probably wrong'
    )
  }
}

if (problems.length > 0) {
  console.error('The client build is no longer portable across base paths:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('See app/lib/runtime-base-path.ts.')
  process.exit(1)
}

console.log(`client build is portable across base paths (prefix ${assetPrefix})`)
