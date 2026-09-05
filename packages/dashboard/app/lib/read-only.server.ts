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

/** Sent as the body of every refusal, and shown verbatim by the route error boundary. */
export const READ_ONLY_MESSAGE = 'This dashboard is read-only (PGBOSS_DASHBOARD_READ_ONLY=1).'

/** Reason line for the refusal, used as the error boundary's heading. */
export const READ_ONLY_STATUS_TEXT = 'Read-only mode'

/**
 * Reject every mutating request at the entry point.
 *
 * Guarding here rather than inside each of the six route actions means a route added
 * later is covered without anyone remembering to guard it. Loaders are untouched, so
 * every page still reads normally; only the methods React Router uses to submit are
 * refused.
 *
 * The refusal is plain text rather than JSON, with the reason in `statusText`. A submit
 * expects a single-fetch response, so anything else becomes a route error — and React
 * Router hands the boundary that status text and body. `ErrorCard` renders both, which
 * is what a stale tab still showing a button gets to see. JSON would arrive as an
 * unparsed blob under a heading about the database being unreachable.
 *
 * Behind a proxy that speaks HTTP/2 the status text is dropped (the protocol has no
 * reason phrase) and the boundary falls back to its own heading; the body survives
 * either way.
 */
export function configureReadOnly (app: Hono): void {
  if (!isReadOnly()) {
    return
  }

  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return next()
    }

    return new Response(READ_ONLY_MESSAGE, {
      status: 403,
      statusText: READ_ONLY_STATUS_TEXT,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  })
}
