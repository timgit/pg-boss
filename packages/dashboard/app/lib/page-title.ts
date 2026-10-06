import type { Params } from 'react-router'

/**
 * What a route calls its page in the browser tab: a fixed name, or one read from its loader data
 * and params, such as a queue's name. Null leaves the tab to a parent's.
 */
export type PageTitle<Data = any> = string | ((page: { data: Data, params: Params }) => string | null)

/** A route's `handle`, as far as titles go. */
export interface TitleHandle<Data = any> {
  title?: PageTitle<Data>
}

/** One matched route, as a title is read from it. */
export interface TitleMatch {
  handle?: unknown
  loaderData?: unknown
  params: Params
}

/** The deepest page's own title, or null; `fallback` names a page whose handle has none. */
export function deepestTitle (matches: TitleMatch[], fallback?: (match: TitleMatch) => string | null): string | null {
  for (let k = matches.length - 1; k >= 0; k--) {
    const match = matches[k]
    const title = (match.handle as TitleHandle | undefined)?.title
    const named = typeof title === 'function'
      ? title({ data: match.loaderData, params: match.params })
      : title ?? fallback?.(match) ?? null
    if (named) return named
  }
  return null
}

/** "demo-billing | pg-boss Dashboard", or the app's name alone. */
export function documentTitle (page: string | null, app: string): string {
  return page ? `${page} | ${app}` : app
}
