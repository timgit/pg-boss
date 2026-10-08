/** A route's `handle`, as far as its scope goes. */
export interface ScopeHandle {
  /** False on a page about no one database, which leaves the database switcher out of the topbar. */
  database?: boolean
}

/** Whether the page is about one database: the deepest route that says decides, and pages that say nothing are. */
export function showsDatabase (matches: Array<{ handle?: unknown }>): boolean {
  for (let k = matches.length - 1; k >= 0; k--) {
    const database = (matches[k].handle as ScopeHandle | undefined)?.database
    if (typeof database === 'boolean') return database
  }
  return true
}
