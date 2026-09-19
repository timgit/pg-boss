export interface ResolvedBasePath {
  /** React Router `basename`: leading slash, no trailing slash (e.g. `/pgboss`), or `/` for root. */
  routerBasename: string
  /** Vite `base`: leading and trailing slash (e.g. `/pgboss/`), or `/` for root. */
  viteBase: string
}

/**
 * Resolves a single base-path input into the two forms the toolchain needs.
 *
 * React Router's `basename` must not have a trailing slash, while Vite's `base`
 * requires one. Deriving both from one value keeps them from drifting.
 */
export function resolveBasePath (raw: string | undefined): ResolvedBasePath {
  const trimmed = raw?.trim()

  if (!trimmed || trimmed === '/') {
    return { routerBasename: '/', viteBase: '/' }
  }

  // Split on slashes and drop the empty segments, rather than trimming the ends.
  // Trimming leaves interior runs alone and mishandles a value that is nothing
  // but slashes, and both of those are worse than they look:
  //
  //   '///'   trimmed to ''      gives viteBase '//', and an asset URL beginning
  //           `//` is protocol-relative — the browser resolves `//assets/x.js`
  //           against a host literally named `assets`, off this machine.
  //   '/a//b' is left as it is, and serveStatic refuses a path containing `//`,
  //           so every asset 404s.
  //
  // Collapsing makes both of them the same value an operator meant to type.
  const segments = trimmed.split('/').filter(Boolean)

  if (segments.length === 0) {
    return { routerBasename: '/', viteBase: '/' }
  }

  const normalised = `/${segments.join('/')}`

  return { routerBasename: normalised, viteBase: `${normalised}/` }
}

/**
 * Remove a mount prefix from a request path before it becomes a filesystem path.
 *
 * This is the only place in the dashboard that turns a URL into a path under
 * `build/client`, and it is the thing keeping requests inside that directory —
 * not serveStatic's traversal guard, which runs on the *raw* path and only
 * rejects `..` bounded by slashes. `/aaaaaaaaaaaa../server/index.js` passes that
 * guard, and a blind `slice(basename.length)` of 13 characters leaves
 * `../server/index.js`: one level out of the static root, into the server
 * bundle.
 *
 * So the prefix is removed only when it is genuinely present *and* ends on a
 * segment boundary. A path that is not under the prefix is returned unchanged
 * rather than trimmed — it cannot be ours, and what is left is then treated as
 * an ordinary segment name that simply misses.
 *
 * Exported, and not inlined into `createHonoApp`, so this can be tested for the
 * property it has rather than through whatever an HTTP-level request happens to
 * hit first. A black-box test cannot distinguish this refusing a path from the
 * static middleware refusing it, which is how the original version of that test
 * passed against the vulnerable code.
 */
export function stripBasePrefix (path: string, basename: string): string {
  if (!basename || basename === '/') {
    return path
  }

  if (path !== basename && !path.startsWith(`${basename}/`)) {
    return path
  }

  const rest = path.slice(basename.length)

  return rest.startsWith('/') ? rest : `/${rest}`
}
