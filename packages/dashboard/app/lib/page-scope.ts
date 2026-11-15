/** A route's `handle`, as far as its scope goes. */
export interface ScopeHandle {
  /** False on a page about no one schema, which leaves the schema switcher out of the topbar. */
  schema?: boolean
}

/** Whether the page is about one schema: the deepest route that says decides, and pages that say nothing are. */
export function showsSchema (matches: Array<{ handle?: unknown }>): boolean {
  for (let k = matches.length - 1; k >= 0; k--) {
    const schema = (matches[k].handle as ScopeHandle | undefined)?.schema
    if (typeof schema === 'boolean') return schema
  }
  return true
}
