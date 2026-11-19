import type { To } from 'react-router'

/**
 * A router `to` as an href that keeps the active schema selection (the `schema` query param). Pure,
 * and apart from the components, so a `.server` module can build the same links.
 */
export function resolveSchemaHref (to: To, schemaParam: string | null): string {
  if (typeof to === 'string') {
    const url = new URL(to, 'http://localhost')
    if (schemaParam && !url.searchParams.has('schema')) {
      url.searchParams.set('schema', schemaParam)
    }
    return url.pathname + url.search + url.hash
  } else if (typeof to === 'object' && to !== null) {
    // Handle object form: { pathname, search, hash }
    const pathname = to.pathname || ''
    const existingSearch = to.search || ''
    const hash = to.hash || ''

    const params = new URLSearchParams(existingSearch.replace(/^\?/, ''))
    if (schemaParam && !params.has('schema')) {
      params.set('schema', schemaParam)
    }
    const search = params.toString()
    return pathname + (search ? `?${search}` : '') + hash
  }
  return String(to)
}
