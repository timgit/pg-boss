import type { ServerBuild } from 'react-router'
import { resolveBasePath } from './base-path'

// The base path ends up inside a Hono route pattern.
const SAFE_BASE_PATH = /^[A-Za-z0-9._~/-]*$/

// The build bakes only two absolute things: the router basename and the asset URLs of the
// route manifest. Rewriting both serves the same build under any prefix, without a rebuild.
// scripts/check-build-portable.mjs fails the build if that stops being true.
export function withBasePath (build: ServerBuild, basePath: string | undefined): ServerBuild {
  if (basePath === undefined) {
    return build
  }

  if (!SAFE_BASE_PATH.test(basePath.trim())) {
    throw new Error(`Invalid base path "${basePath}": use letters, digits and . _ ~ - / only`)
  }

  if (basePath.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(`Invalid base path "${basePath}": it must not contain . or .. segments`)
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

// Byte for byte what `react-router build` writes to the static assets/manifest-*.js.
export function renderManifestSource (build: ServerBuild): string {
  return `window.__reactRouterManifest=${JSON.stringify(build.assets)};`
}
