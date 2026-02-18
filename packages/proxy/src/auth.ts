import type { OpenAPIHono } from '@hono/zod-openapi'
import { basicAuth } from 'hono/basic-auth'

type ProxyEnv = Record<string, string | undefined>

export function configureAuth (app: OpenAPIHono, env: ProxyEnv, prefix: string): void {
  const username = env.PGBOSS_PROXY_AUTH_USERNAME
  const password = env.PGBOSS_PROXY_AUTH_PASSWORD

  if (username && !password) {
    throw new Error('PGBOSS_PROXY_AUTH_PASSWORD is required when PGBOSS_PROXY_AUTH_USERNAME is set')
  }

  if (!username && password) {
    throw new Error('PGBOSS_PROXY_AUTH_USERNAME is required when PGBOSS_PROXY_AUTH_PASSWORD is set')
  }

  if (username && password) {
    app.use(`${prefix}/*`, basicAuth({ username, password }))
  }
}
