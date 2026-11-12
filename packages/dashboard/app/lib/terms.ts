import overlay from '~pro'

/**
 * Whether this build carries a Pro overlay, read when a term is used rather than when this module
 * loads: Pro's overlay imports components that import this, so the overlay is still loading then.
 */
function pro (): boolean {
  return overlay.nav.length > 0 || Object.keys(overlay.slots).length > 0
}

/**
 * What a monitored pg-boss is called in this build, and the URL parameter that names the one a page
 * shows. pg-boss Pro calls each one an app, added and removed in its Console. The dashboard calls each
 * one a database, read from DATABASE_URL.
 */
export const term = {
  get one () { return pro() ? 'app' : 'database' },
  get many () { return pro() ? 'apps' : 'databases' },
  get One () { return pro() ? 'App' : 'Database' },
  get Many () { return pro() ? 'Apps' : 'Databases' },
  get param () { return pro() ? 'schema' : 'db' },
}
