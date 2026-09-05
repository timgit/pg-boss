import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { configureReadOnly, isReadOnly } from '~/lib/read-only.server'

function appWithRoutes (): Hono {
  const app = new Hono()
  configureReadOnly(app)
  app.get('/test', (c) => c.text('read'))
  app.post('/test', (c) => c.text('wrote'))
  app.put('/test', (c) => c.text('wrote'))
  app.patch('/test', (c) => c.text('wrote'))
  app.delete('/test', (c) => c.text('wrote'))
  return app
}

describe('read-only mode', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PGBOSS_DASHBOARD_READ_ONLY
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('isReadOnly', () => {
    it('is off when the variable is unset', () => {
      expect(isReadOnly()).toBe(false)
    })

    it('is on for exactly "1"', () => {
      process.env.PGBOSS_DASHBOARD_READ_ONLY = '1'
      expect(isReadOnly()).toBe(true)
    })

    it('ignores other truthy-looking values, so a typo fails closed to writable', () => {
      for (const value of ['true', 'yes', 'on', '0', '']) {
        process.env.PGBOSS_DASHBOARD_READ_ONLY = value
        expect(isReadOnly()).toBe(false)
      }
    })
  })

  describe('configureReadOnly', () => {
    it('leaves every method alone when disabled', async () => {
      const app = appWithRoutes()

      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await app.request('/test', { method })
        expect(res.status, method).toBe(200)
      }
    })

    it('allows reads when enabled', async () => {
      process.env.PGBOSS_DASHBOARD_READ_ONLY = '1'
      const app = appWithRoutes()

      const res = await app.request('/test')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('read')

      const head = await app.request('/test', { method: 'HEAD' })
      expect(head.status).toBe(200)
    })

    it('rejects every mutating method when enabled', async () => {
      process.env.PGBOSS_DASHBOARD_READ_ONLY = '1'
      const app = appWithRoutes()

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await app.request('/test', { method })
        expect(res.status, method).toBe(403)
        expect((await res.json() as { error: string }).error).toContain('read-only')
      }
    })

    it('covers paths that have no route of their own, so a route added later is guarded', async () => {
      process.env.PGBOSS_DASHBOARD_READ_ONLY = '1'
      const app = appWithRoutes()

      const res = await app.request('/queues/some-queue/jobs/abc', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })
})
