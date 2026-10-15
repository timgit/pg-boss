import { resolve } from 'node:path'

/**
 * `PGBOSS_CORE=src` points `pg-boss` at this repository's own source instead of the installed
 * package, for a dashboard change that needs core not yet on npm. Dev and tests only: the build
 * refuses it, so a release always runs against the pg-boss its manifest declares.
 *
 * `tsc` and `tsx` read `tsconfig.core-src.json` for the same redirect, since tsconfig `paths`
 * cannot depend on the environment.
 */
export const coreFromSource = process.env.PGBOSS_CORE === 'src'

// `pg-boss/dist/*` first: a test reads core internals from the package's build output, which in
// the source tree are the modules themselves.
export function coreAlias (): Record<string, string> {
  const src = resolve(import.meta.dirname, '../../../src')
  return coreFromSource ? { 'pg-boss/dist': src, 'pg-boss': src } : {}
}
