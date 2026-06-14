import type { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'

export function configureAuth (app: Hono): void {
  const username = process.env.PGBOSS_DASHBOARD_AUTH_USERNAME
  const password = process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD

  if (username && !password) {
    throw new Error('PGBOSS_DASHBOARD_AUTH_PASSWORD is required when PGBOSS_DASHBOARD_AUTH_USERNAME is set')
  }

  if (!username && password) {
    throw new Error('PGBOSS_DASHBOARD_AUTH_USERNAME is required when PGBOSS_DASHBOARD_AUTH_PASSWORD is set')
  }

  if (username && password) {
    app.use(basicAuth({ username, password }))
  }
}
