import type { Hono } from 'hono'

/**
 * Read-only mode. `PGBOSS_DASHBOARD_READ_ONLY=true` (or `1`) turns off sending, retrying,
 * cancelling, resuming and deleting jobs, and adding and removing schedules: every request that could
 * change something is refused, and the buttons are hidden.
 *
 * A global switch, not authentication: everyone who can reach the dashboard gets the same view.
 * Read at call time rather than at import time so tests can exercise both states.
 */
export function isReadOnly (): boolean {
  const value = process.env.PGBOSS_DASHBOARD_READ_ONLY
  return value === 'true' || value === '1'
}

/** Sent as the body of every refusal, and shown by the route error boundary. */
export const READ_ONLY_MESSAGE = 'This dashboard is read-only (PGBOSS_DASHBOARD_READ_ONLY).'

/**
 * The startup warning for a dashboard on which anyone who reaches it can change jobs, or null.
 * `checksAuth` is whether the dashboard applies `PGBOSS_DASHBOARD_AUTH_*` itself: the standalone
 * server does, and a mounted handler leaves authentication to its host, which it can't see.
 */
export function openWritesWarning (checksAuth: boolean, credential: boolean): string | null {
  if (!checksAuth || credential || isReadOnly()) return null

  return 'pg-boss dashboard: anyone who can reach this dashboard can send, retry, cancel, resume and delete jobs, and add and remove schedules. ' +
    'Set PGBOSS_DASHBOARD_AUTH_USERNAME and PGBOSS_DASHBOARD_AUTH_PASSWORD to ask for a password, ' +
    'or PGBOSS_DASHBOARD_READ_ONLY=true to turn changes off.'
}

/**
 * Refuses every request but a read, at the entry point.
 *
 * Here rather than inside the route action, so an action added later is covered without anyone
 * remembering to guard it. The refusal is plain text with the reason as its status text, which
 * React Router hands the error boundary of a stale tab that still shows a button.
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
      statusText: 'Read-only mode',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  })
}
