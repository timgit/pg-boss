import { readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every bare import left in the build must be a package the install provides.
 *
 * The server build bundles its dependencies and keeps a short allowlist
 * external; the esbuild entry points keep everything external. Either way the
 * output ends up with bare imports that are resolved from `node_modules` at the
 * customer's runtime, and nothing checked that the manifest actually declares
 * them. It does not fail the build, it does not fail the tests, and the suites
 * never load the built output — it fails at `import` time on someone else's
 * machine, and only if their package manager does not hoist.
 *
 * That is not hypothetical. `cron-parser`, `rrule-temporal` and `serialize-error`
 * reach the bundle through the `pg-boss` source alias and were never declared;
 * they resolved under npm because `pg-boss` is a dependency and npm flattens its
 * tree, and they crash under pnpm with `hoist=false`.
 *
 * A dependency is what counts. `devDependencies` are not installed by a consumer,
 * so an import satisfied by one is exactly the bug this looks for.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const declared = new Set(Object.keys(pkg.dependencies ?? {}))
const builtins = new Set(builtinModules)

/**
 * Bare specifiers in bundled output.
 *
 * Deliberately a regex rather than a parser. The inputs are generated
 * JavaScript, the forms are the four a bundler emits, and a parser would still
 * miss a specifier built at runtime — which no bundler produces and which this
 * could not check anyway. The failure mode is a missed import, not a false one.
 */
const PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
]

/** `@scope/name/deep` and `name/deep` both collapse to the installable package. */
function packageName (specifier) {
  const parts = specifier.split('/')

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * What a package specifier can actually look like.
 *
 * The patterns above find the word `from` inside minified strings and object
 * literals too — `[{ from: scaleColor() }]` matched on the first run. A
 * specifier is a restricted string, so requiring the shape removes those without
 * needing to understand the surrounding code.
 */
const SPECIFIER = /^@?[a-zA-Z0-9][a-zA-Z0-9._~-]*(\/[a-zA-Z0-9._~-]+)*$/

function isBare (specifier) {
  return SPECIFIER.test(specifier) &&
    !specifier.startsWith('.') && !specifier.startsWith('/') &&
    !specifier.includes(':')
}

function * walk (dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)

    if (statSync(path).isDirectory()) {
      yield * walk(path)
    } else if (['.js', '.mjs', '.cjs'].includes(extname(path))) {
      yield path
    }
  }
}

const offenders = new Map()

for (const file of walk(join(root, 'build'))) {
  const source = readFileSync(file, 'utf8')

  for (const pattern of PATTERNS) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (!isBare(specifier)) {
        continue
      }

      const name = packageName(specifier)

      if (builtins.has(name) || declared.has(name)) {
        continue
      }

      const where = offenders.get(name) ?? new Set()
      where.add(file.slice(root.length + 1))
      offenders.set(name, where)
    }
  }
}

if (offenders.size > 0) {
  const lines = [...offenders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, files]) => {
      const kind = pkg.devDependencies?.[name]
        ? 'a devDependency, which a consumer does not install'
        : 'not in package.json at all'

      return `  - ${name} (${kind})\n      ${[...files].sort().join('\n      ')}`
    })

  console.error(
    'The build imports packages the install does not provide:\n\n' +
    lines.join('\n') +
    '\n\nEither bundle them or declare them in dependencies. These resolve under\n' +
    'npm when a declared dependency happens to hoist them, and fail under a\n' +
    'package manager that does not.\n'
  )

  process.exit(1)
}

console.log('every bare import in the build is declared')
