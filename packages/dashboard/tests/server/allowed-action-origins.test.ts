import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from '~/server'
import { createDashboardHandler } from '~/handler'

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

// The embedded handler imports the production build from here; `npm run build` writes it.
// A mocked module throws on a missing export, so name the optional ones the server reads.
// A build with no list in react-router.config.ts exports `allowedActionOrigins = false`.
vi.mock('~/server/index.js', () => ({ ...build, allowedActionOrigins: false, unstable_getCriticalCss: undefined }))

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

  it('matches a wildcard entry per label', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = '*.example.com'
    const app = createHonoApp({ build, mode: 'production', overlay: null })

    expect((await proxiedPost(app)).status).toBe(200)
    expect((await proxiedPost(app, 'https://pgboss.example.com.evil.net')).status).toBe(400)
  })

  it('keeps a non-default port: http on 443 sends it in Origin', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'pgboss.example.com:443'

    const res = await proxiedPost(createHonoApp({ build, mode: 'production', overlay: null }), 'http://pgboss.example.com:443')

    expect(res.status).toBe(200)
  })

  it('adds to the list the build already has instead of replacing it', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'pgboss.example.com'
    const app = createHonoApp({ build: { ...build, allowedActionOrigins: ['admin.example.org'] }, mode: 'production', overlay: null })

    expect((await proxiedPost(app, 'https://admin.example.org')).status).toBe(200)
    expect((await proxiedPost(app)).status).toBe(200)
  })

  it('stops startup on a build whose own list would turn off the check', () => {
    expect(() => createHonoApp({ build: { ...build, allowedActionOrigins: ['**'] }, mode: 'production', overlay: null }))
      .toThrow('The build\'s allowedActionOrigins entry "**" matches too many hosts')
  })

  it('checks and normalizes a list passed as the option, like the variable', async () => {
    expect(() => createHonoApp({ build, mode: 'production', allowedActionOrigins: ['**'], overlay: null }))
      .toThrow('allowedActionOrigins entry "**" matches too many hosts')

    const res = await proxiedPost(createHonoApp({ build, mode: 'production', allowedActionOrigins: ['PgBoss.Example.com:443'], overlay: null }))

    expect(res.status).toBe(200)
  })

  it('is ignored when the caller passes its own list', async () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'pgboss.example.com'

    const res = await proxiedPost(createHonoApp({ build, mode: 'production', allowedActionOrigins: [], overlay: null }))

    expect(res.status).toBe(400)
  })
})

describe('createDashboardHandler allowedActionOrigins', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const post = (handler: ReturnType<typeof createDashboardHandler>) => handler(new Request('http://pgboss.example.com/', {
    method: 'POST',
    headers: { Origin: 'https://pgboss.example.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'intent=retry',
  }))

  it('runs an action from a host the option lists', async () => {
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }], allowedActionOrigins: ['pgboss.example.com'] })

    expect((await post(handler)).status).toBe(200)
    await handler.close()
  })

  it('ignores a valid value: the host app passes its own list', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS', 'pgboss.example.com')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    expect((await post(handler)).status).toBe(400)
    await handler.close()
  })

  it('ignores an invalid value instead of failing every request', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS', '**')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    expect((await post(handler)).status).toBe(400)
    await handler.close()
  })
})
