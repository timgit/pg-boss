import type { ServerBuild } from 'react-router'
import { resolveBasePath } from './base-path'

// Anything else would end up inside a Hono route pattern and a URL prefix.
const SAFE_BASE_PATH = /^[A-Za-z0-9._~/-]*$/

/**
 * Re-home a server build under a base path chosen at runtime.
 *
 * `react-router build` bakes two things: the router `basename`, and the asset URLs
 * listed in the route manifest. Today nothing else in the output is absolute — chunks
 * import each other relatively and no dynamic import carries preload dependencies — so
 * serving the same build under another prefix only takes rewriting those. That is what
 * lets the prebuilt npm package be mounted under a sub-path without a rebuild.
 * `scripts/check-build-portable.mjs` fails the build if that stops being true.
 */
export function withBasePath (build: ServerBuild, basePath: string | undefined): ServerBuild {
  if (basePath === undefined) {
    return build
  }

  if (!SAFE_BASE_PATH.test(basePath.trim())) {
    throw new Error(`Invalid base path "${basePath}": use letters, digits and . _ ~ - / only`)
  }

  const { routerBasename, viteBase } = resolveBasePath(basePath)

  if (viteBase === build.publicPath && routerBasename === (build.basename ?? '/')) {
    return build
  }

  return {
    ...build,
    basename: routerBasename,
    publicPath: viteBase,
    assets: rehomeAssetUrls(build.assets, build.publicPath, viteBase),
  }
}

/** Swap the leading public path of every asset URL found in a manifest-shaped value. */
export function rehomeAssetUrls<T> (value: T, fromPublicPath: string, toPublicPath: string): T {
  const from = `${fromPublicPath}assets/`
  const to = `${toPublicPath}assets/`

  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.startsWith(from) ? to + node.slice(from.length) : node
    }
    if (Array.isArray(node)) {
      return node.map(visit)
    }
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]))
    }
    return node
  }

  return visit(value) as T
}

/**
 * The browser also loads the manifest as a static file (`assets/manifest-*.js`), a second
 * copy of the same URLs. It is exactly this serialization of `build.assets`, so it can be
 * produced from the re-homed build rather than patched on disk.
 */
export function renderManifestSource (build: ServerBuild): string {
  return `window.__reactRouterManifest=${JSON.stringify(build.assets)};`
}
