import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from '~/server'

// A real build with one action, so the request goes through React Router's origin check.
const build = {
  basename: '/',
  publicPath: '/',
  ssr: true,
  isSpaMode: false,
  prerender: [],
  future: {},
  routeDiscovery: { mode: 'initial' },
  assets: { url: '/assets/manifest-1.js', version: '1', entry: { module: '/assets/entry.client-1.js', imports: [], css: [] }, routes: {} },
  entry: { module: { default: async (_request: Request, status: number) => new Response('rendered', { status }) } },
  routes: { root: { id: 'root', path: '', module: { default: () => null, action: () => ({ ok: true }) } } },
} as unknown as ServerBuild

// What a TLS proxy forwards: the server sees plain HTTP, the browser sent its public origin.
const proxiedPost = (app: ReturnType<typeof createHonoApp>, origin = 'https://pgboss.example.com') => app.request('http://pgboss.example.com/', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'intent=retry',
})

describe('PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PGBOSS_DASHBOARD_AUTH_USERNAME
    delete process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD
    delete process.env.PGBOSS_DASHBOARD_READ_ONLY
    delete process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('rejects a proxied action when unset', async () => {
    const res = await proxiedPost(createHonoApp({ build, mode: 'production', overlay: null }))

    expect(res.status).toBe(400)
  })

  it('runs a proxied action from a listed host', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'PgBoss.Example.com:443'

    const res = await proxiedPost(createHonoApp({ build, mode: 'production', overlay: null }))

    expect(res.status).toBe(200)
  })

  it('still rejects an action from another host', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'pgboss.example.com'

    const res = await proxiedPost(createHonoApp({ build, mode: 'production', overlay: null }), 'https://evil.example.net')

    expect(res.status).toBe(400)
  })

  it('applies to a build loaded per request, as the dev server passes it', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'pgboss.example.com'

    const res = await proxiedPost(createHonoApp({ build: () => build, mode: 'development', overlay: null }))

    expect(res.status).toBe(200)
  })

  it('stops startup on an entry that would turn off the check', () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = '**'

    expect(() => createHonoApp({ build, mode: 'production', overlay: null })).toThrow('matches too many hosts')
  })

  it('is ignored when the caller passes its own list', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'pgboss.example.com'

    const res = await proxiedPost(createHonoApp({ build, mode: 'production', allowedActionOrigins: [], overlay: null }))

    expect(res.status).toBe(400)
  })
})
