import type { Hono } from 'hono'

/**
 * Read-only mode. `PGBOSS_DASHBOARD_READ_ONLY=1` turns the dashboard into a viewer:
 * every mutating request is rejected and every mutating control is hidden.
 *
 * This is a global switch, not authentication. Everyone who can reach the dashboard
 * gets the same read-only view, so it grants no per-user rights and replaces nothing
 * that `PGBOSS_DASHBOARD_AUTH_*` does.
 *
 * Read at call time rather than at import time so tests can exercise both states,
 * matching `proEnabled()`.
 */
export function isReadOnly (): boolean {
  return process.env.PGBOSS_DASHBOARD_READ_ONLY === '1'
}

/**
 * Reject every mutating request at the entry point.
 *
 * Guarding here rather than inside each of the six route actions means a route added
 * later is covered without anyone remembering to guard it. Loaders are untouched, so
 * every page still reads normally; only the methods React Router uses to submit are
 * refused.
 */
export function configureReadOnly (app: Hono): void {
  if (!isReadOnly()) {
    return
  }

  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return next()
    }

    return c.json(
      { error: 'This dashboard is read-only (PGBOSS_DASHBOARD_READ_ONLY=1).' },
      403
    )
  })
}
