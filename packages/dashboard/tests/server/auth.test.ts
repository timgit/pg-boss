import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { configureAuth } from '~/lib/auth.server'

function encodeBasicAuth (username: string, password: string): string {
  return 'Basic ' + btoa(`${username}:${password}`)
}

describe('configureAuth', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PGBOSS_DASHBOARD_AUTH_USERNAME
    delete process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('does not add auth middleware when env vars are not set', async () => {
    const app = new Hono()
    configureAuth(app)
    app.get('/test', (c) => c.text('ok'))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('throws when only username is set', () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'

    const app = new Hono()
    expect(() => configureAuth(app)).toThrow('PGBOSS_DASHBOARD_AUTH_PASSWORD is required when PGBOSS_DASHBOARD_AUTH_USERNAME is set')
  })

  it('throws when only password is set', () => {
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const app = new Hono()
    expect(() => configureAuth(app)).toThrow('PGBOSS_DASHBOARD_AUTH_USERNAME is required when PGBOSS_DASHBOARD_AUTH_PASSWORD is set')
  })

  it('requires auth when both env vars are set', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const app = new Hono()
    configureAuth(app)
    app.get('/test', (c) => c.text('ok'))

    const res = await app.request('/test')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Basic')
  })

  it('allows access with correct credentials', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const app = new Hono()
    configureAuth(app)
    app.get('/test', (c) => c.text('ok'))

    const res = await app.request('/test', {
      headers: { Authorization: encodeBasicAuth('admin', 'secret') },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('rejects incorrect credentials', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const app = new Hono()
    configureAuth(app)
    app.get('/test', (c) => c.text('ok'))

    const res = await app.request('/test', {
      headers: { Authorization: encodeBasicAuth('admin', 'wrong') },
    })
    expect(res.status).toBe(401)
  })

  it('protects all routes', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const app = new Hono()
    configureAuth(app)
    app.get('/queues', (c) => c.text('queues'))
    app.get('/jobs', (c) => c.text('jobs'))

    const headers = { Authorization: encodeBasicAuth('admin', 'secret') }

    const noAuth1 = await app.request('/queues')
    expect(noAuth1.status).toBe(401)

    const noAuth2 = await app.request('/jobs')
    expect(noAuth2.status).toBe(401)

    const withAuth1 = await app.request('/queues', { headers })
    expect(withAuth1.status).toBe(200)

    const withAuth2 = await app.request('/jobs', { headers })
    expect(withAuth2.status).toBe(200)
  })
})
