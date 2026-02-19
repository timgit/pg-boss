import type { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'

type ProxyEnv = Record<string, string | undefined>

export function configureCors (app: OpenAPIHono, env: ProxyEnv, prefix: string): void {
  const origin = env.PGBOSS_PROXY_CORS_ORIGIN

  if (!origin) {
    return
  }

  const origins = origin.split(',').map((o) => o.trim())

  const options: Parameters<typeof cors>[0] = {
    origin: origins.length === 1 && origins[0] === '*' ? '*' : origins,
    allowMethods: env.PGBOSS_PROXY_CORS_METHODS?.split(',').map((m) => m.trim()) ?? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: env.PGBOSS_PROXY_CORS_HEADERS?.split(',').map((h) => h.trim()) ?? ['Content-Type', 'Authorization'],
    exposeHeaders: env.PGBOSS_PROXY_CORS_EXPOSE_HEADERS?.split(',').map((h) => h.trim()) ?? [],
    credentials: env.PGBOSS_PROXY_CORS_CREDENTIALS === 'true',
    maxAge: env.PGBOSS_PROXY_CORS_MAX_AGE ? parseInt(env.PGBOSS_PROXY_CORS_MAX_AGE, 10) : undefined
  }

  app.use(`${prefix}/*`, cors(options))
}
