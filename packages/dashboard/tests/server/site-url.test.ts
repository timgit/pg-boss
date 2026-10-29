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
  entry: { module: { default: async (_request: Request, status: number) => new Response('rendered', { status }), serverOverlay: {} } },
  routes: { root: { id: 'root', path: '', module: { default: () => null, action: () => ({ ok: true }) } } },
} as unknown as ServerBuild

// The embedded handler imports the production build from here; `npm run build` writes it.
// A mocked module throws on a missing export, so name the optional ones the server reads.
// React Router's build exports `allowedActionOrigins = false` when the config sets none.
vi.mock('~/server/index.js', () => ({ ...build, allowedActionOrigins: false, unstable_getCriticalCss: undefined, unstable_apiOnly: undefined, unstable_apiServerOrigin: undefined }))

// What a TLS proxy forwards: the server sees plain HTTP, the browser sent its public origin.
const proxiedPost = (app: ReturnType<typeof createHonoApp>, origin = 'https://pgboss.example.com') => app.request('http://pgboss.example.com/', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'intent=retry',
})

describe('PGBOSS_DASHBOARD_SITE_URL', () => {
  beforeEach(() => {
    vi.stubEnv('PGBOSS_DASHBOARD_AUTH_USERNAME', '')
    vi.stubEnv('PGBOSS_DASHBOARD_AUTH_PASSWORD', '')
    vi.stubEnv('PGBOSS_DASHBOARD_READ_ONLY', '')
    vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const app = () => createHonoApp({ build, mode: 'production', overlay: null })

  it('runs a proxied action from the site origin', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', 'https://PgBoss.Example.com/')

    const res = await proxiedPost(app())

    expect(res.status).toBe(200)
  })

  it('rejects the same action when unset', async () => {
    const res = await proxiedPost(app())

    expect(res.status).toBe(400)
  })

  it('still rejects an action from another site', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', 'https://pgboss.example.com')

    const res = await proxiedPost(app(), 'https://evil.example.net')

    expect(res.status).toBe(400)
  })

  it('keeps the site host for a path that starts with two slashes', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', 'https://pgboss.example.com')

    const res = await app().request('http://127.0.0.1:3000//evil.example.net/', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.net', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'intent=retry',
    })

    expect(res.status).toBe(400)
  })

  it('applies to a build loaded per request, as the dev server passes it', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', 'https://pgboss.example.com')

    const res = await proxiedPost(createHonoApp({ build: () => build, mode: 'development', overlay: null }))

    expect(res.status).toBe(200)
  })

  it('stops startup on a value that is not an origin', () => {
    for (const value of ['pgboss.example.com', 'https://pgboss.example.com/pgboss', 'ftp://pgboss.example.com', 'https://user@pgboss.example.com']) {
      vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', value)

      expect(() => app()).toThrow(`PGBOSS_DASHBOARD_SITE_URL "${value}" is not a site URL`)
    }
  })

  it('gives way to the option, and null turns it off', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', 'https://pgboss.example.com')

    expect((await proxiedPost(createHonoApp({ build, mode: 'production', siteUrl: null, overlay: null }))).status).toBe(400)
    expect((await proxiedPost(createHonoApp({ build, mode: 'production', siteUrl: 'https://admin.example.org', overlay: null }), 'https://admin.example.org')).status).toBe(200)
  })
})

describe('createDashboardHandler siteUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const post = (handler: ReturnType<typeof createDashboardHandler>) => handler(new Request('http://pgboss.example.com/', {
    method: 'POST',
    headers: { Origin: 'https://pgboss.example.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'intent=retry',
  }))

  it('runs an action from the site origin the option names', async () => {
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }], siteUrl: 'https://pgboss.example.com' })

    expect((await post(handler)).status).toBe(200)
    await handler.close()
  })

  it('ignores PGBOSS_DASHBOARD_SITE_URL: only the option applies', async () => {
    vi.stubEnv('PGBOSS_DASHBOARD_SITE_URL', 'https://pgboss.example.com')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    expect((await post(handler)).status).toBe(400)
    await handler.close()
  })
})
