import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Collects the third-party packages whose code is actually in the build, and
 * writes them out for whoever redistributes it.
 *
 * The obvious way to answer "what do we redistribute" is to walk the dependency
 * tree — `npm ls --omit=dev` — and that used to be right, back when the server
 * build left its dependencies external and the install carried each one with its
 * own licence file beside it. Bundling broke that identity in both directions:
 * `devDependencies` are now bundled and shipped, `dependencies` may be external
 * and never touched, and nothing in the manifest says which is which.
 *
 * So this reads the module graph instead. Every module Rollup pulled in that
 * resolves inside a `node_modules` directory belongs to a package, and that
 * package's code is in the output. It is the only list that answers the question
 * as asked, and it stays correct when a dependency moves between the two
 * sections of `package.json` — or when a Pro overlay brings its own.
 *
 * Both environments contribute. The client bundle carries React, the icon set
 * and the UI kit; the server bundle carries those plus whatever renders. A
 * package that appears in either one is redistributed.
 *
 * Emits `build/third-party.json`. The free package's notices are generated from
 * it, and so are @pg-boss/pro's, which is why it is a data file rather than
 * formatted text: Pro's licence obligations are its own and its file says
 * different things around the same list.
 */

export interface ThirdPartyPackage {
  name: string
  version: string
  /** From `package.json`, which is what tooling reads. Absent is worth noticing. */
  license: string | null
  /** The text of LICENSE, when the package ships one. */
  licenseText: string | null
  /** Which bundles carry this package's code. */
  environments: string[]
}

/** Walk up from a module path to the directory holding its `package.json`. */
function packageRootFor (id: string): string | null {
  const marker = `${sep}node_modules${sep}`
  const index = id.lastIndexOf(marker)

  if (index === -1) {
    return null
  }

  // Start inside node_modules and walk down until a package.json appears, so a
  // scoped package resolves to `@scope/name` rather than `@scope`.
  let dir = dirname(id)
  const stop = id.slice(0, index + marker.length)

  while (dir.startsWith(stop)) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir
    }

    const parent = dirname(dir)

    if (parent === dir) {
      break
    }

    dir = parent
  }

  return null
}

const LICENSE_FILES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'LICENCE', 'LICENCE.md', 'LICENCE.txt',
  'license', 'license.md', 'license.txt',
  'COPYING', 'COPYING.md',
]

function readLicenseText (root: string): string | null {
  for (const name of LICENSE_FILES) {
    const path = join(root, name)

    if (existsSync(path)) {
      return readFileSync(path, 'utf8').trim()
    }
  }

  return null
}

function readLicenseField (pkg: Record<string, unknown>): string | null {
  const { license, licenses } = pkg as {
    license?: string | { type?: string }
    licenses?: Array<{ type?: string }>
  }

  if (typeof license === 'string') {
    return license
  }

  if (license && typeof license === 'object' && license.type) {
    return license.type
  }

  // The deprecated array form, still present in a few long-lived packages.
  if (Array.isArray(licenses)) {
    const types = licenses.map((entry) => entry.type).filter(Boolean)

    return types.length > 0 ? types.join(' OR ') : null
  }

  return null
}

/**
 * Accumulates across environments. Vite builds the client and the server in one
 * command but as separate Rollup runs, so the plugin instance sees each in turn
 * and the file is rewritten with the union each time.
 */
export function thirdPartyPlugin (outFile = 'build/third-party.json'): Plugin {
  const found = new Map<string, ThirdPartyPackage>()
  let root = process.cwd()

  return {
    name: 'pgboss-third-party',
    apply: 'build',

    configResolved (config) {
      root = config.root
    },

    // After the chunks are written, so the graph is final.
    writeBundle () {
      const environment = this.environment?.name ?? 'client'

      for (const id of this.getModuleIds()) {
        // Named apart from the config root above, which is used below. Shadowing
        // it here works and reads like a bug.
        const packageRoot = packageRootFor(id)

        if (!packageRoot) {
          continue
        }

        let pkg: Record<string, unknown>

        try {
          pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
        } catch {
          continue
        }

        const name = typeof pkg.name === 'string' ? pkg.name : null

        if (!name) {
          continue
        }

        const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
        const key = `${name}@${version}`
        const existing = found.get(key)

        if (existing) {
          if (!existing.environments.includes(environment)) {
            existing.environments.push(environment)
          }

          continue
        }

        found.set(key, {
          name,
          version,
          license: readLicenseField(pkg),
          licenseText: readLicenseText(packageRoot),
          environments: [environment],
        })
      }

      const packages = [...found.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
      )

      // Written directly rather than emitted as an asset. Each environment has
      // its own outDir — `build/client`, `build/server` — and this belongs to
      // neither: it describes the whole build, and Rollup refuses to emit an
      // asset outside the directory it is writing.
      const path = join(root, outFile)

      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ packages }, null, 2) + '\n')
    },
  }
}

/**
 * Render the data file as the notices text a package ships.
 *
 * Shared so the free dashboard and @pg-boss/pro produce the same list from the
 * same source, and differ only in the wording around it.
 */
export function renderNotices (packages: ThirdPartyPackage[], preamble: string): string {
  const lines: string[] = [preamble.trim(), '']

  for (const pkg of packages) {
    lines.push('-'.repeat(72))
    lines.push(`${pkg.name}@${pkg.version} — ${pkg.license ?? 'licence not declared'}`)
    lines.push('')

    if (pkg.licenseText) {
      lines.push(pkg.licenseText)
    } else {
      lines.push(
        'This package ships no licence file. Its package.json declares ' +
        `${pkg.license ?? 'no licence'}.`
      )
    }

    lines.push('')
  }

  return lines.join('\n')
}
