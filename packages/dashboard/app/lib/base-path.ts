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

  const normalised = `/${trimmed.replace(/^\/+|\/+$/g, '')}`

  return { routerBasename: normalised, viteBase: `${normalised}/` }
}
