import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { RouteConfigEntry } from '@react-router/dev/routes'

/**
 * Build-time resolution of the optional Pro overlay. See `pro-contract.ts` for
 * what an overlay provides.
 *
 * The overlay is a directory at `app/pro/`, absent from this repository and
 * cloned in by a Pro build. Presence alone does not enable it — `PGBOSS_PRO=1`
 * must also be set, so a build is never silently different from what was asked
 * for. Setting the flag without an overlay is a hard error rather than a
 * quiet fallback.
 *
 * Two halves, resolved two ways, because React Router's config loader runs
 * outside the Vite module graph and honours neither `resolve.alias` nor `~`:
 *
 * - **Config-time** — `proRoutes()`, imported by relative path from
 *   `app/routes.ts`. Anything reachable from `app/pro/routes.ts` must avoid `~`
 *   imports for the same reason. Route definitions are pure data, so that costs
 *   the overlay nothing.
 * - **Runtime** — `proAlias()` gives Vite and Vitest the target for `~pro`,
 *   which resolves to the no-op `pro-stub.ts` in every ordinary build.
 */

const here = dirname(fileURLToPath(import.meta.url))

/** Where a Pro build clones the overlay. The default for every caller but the tests. */
export const overlayDir = join(here, '..', 'pro')
export const stubPath = join(here, 'pro-stub.ts')

/** Read at call time rather than import time, so tests can exercise both states. */
export function proEnabled (): boolean {
  return process.env.PGBOSS_PRO === '1'
}

function requireOverlay (dir: string): void {
  if (!existsSync(dir)) {
    throw new Error(
      `PGBOSS_PRO=1 but no overlay is present at ${dir}. ` +
      'Clone the Pro overlay into that directory before building, or unset PGBOSS_PRO.'
    )
  }
}

/**
 * Target for the `~pro` alias: the overlay's runtime entry, or the stub.
 *
 * `dir` exists so the tests can point at a scratch directory they own. Nothing
 * here ever writes to or removes `dir`, and no test may pass `overlayDir` — a
 * developer's overlay clone is live, uncommitted work.
 */
export function proAlias (dir: string = overlayDir): string {
  if (!proEnabled()) {
    return stubPath
  }

  requireOverlay(dir)
  return join(dir, 'index.tsx')
}

/** Routes the overlay adds, appended to the free route table. See `proAlias` on `dir`. */
export async function proRoutes (dir: string = overlayDir): Promise<RouteConfigEntry[]> {
  if (!proEnabled()) {
    return []
  }

  requireOverlay(dir)

  // The specifier is computed so TypeScript does not try to resolve a directory
  // that is absent from every build but a Pro one.
  const entry = pathToFileURL(join(dir, 'routes.ts')).href
  const { default: routes } = await import(/* @vite-ignore */ entry) as { default: RouteConfigEntry[] }
  return routes
}
