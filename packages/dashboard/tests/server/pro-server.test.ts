import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createHonoApp, getLoadContext } from '~/server'
import { serverOverlay as stub } from '~pro-server'
import { dbContext } from '~/lib/db-context'
import type { ProServerOverlay } from '~/lib/pro-contract'

/**
 * The server half of the overlay seam.
 *
 * Which overlay reaches `createHonoApp` is decided by the `~pro-server` alias at
 * build time and cannot vary per test, so every case passes the overlay it means
 * to exercise directly — the same reason the frontend suite pins `~pro` rather
 * than trusting what the alias resolved to.
 */

/** A request that the overlay's own middleware answers, so no build is needed. */
function probe (overlay: ProServerOverlay | null) {
  const app = createHonoApp({
    build: { basename: '/' } as never,
    mode: 'production',
    overlay,
  })
  return app.request('/probe')
}

const answersProbe: ProServerOverlay = {
  server: (app: Hono) => {
    app.get('/probe', (c) => c.text('overlay'))
  },
}

describe('the stub every free build resolves to', () => {
  it('has no hooks on it, so nothing in createHonoApp changes', () => {
    expect(stub).toEqual({})
  })
})

describe('createHonoApp with an overlay', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.PGBOSS_DASHBOARD_AUTH_USERNAME
    delete process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('registers the overlay middleware', async () => {
    const res = await probe(answersProbe)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('overlay')
  })

  it('changes nothing when there is no overlay', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    // No overlay route to answer it, so this reaches the Basic-auth gate and stops.
    const res = await probe(null)

    expect(res.status).toBe(401)
  })

  /**
   * Hono dispatches in registration order, so an overlay registered before the
   * Basic-auth middleware would answer without it. Mounting Pro on a dashboard
   * that was password-protected yesterday must not open a hole in it.
   */
  it('gates an overlay that does not claim auth behind Basic auth', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const res = await probe(answersProbe)

    expect(res.status).toBe(401)
  })

  it('serves that same overlay route once the credential is supplied', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const app = createHonoApp({ build: { basename: '/' } as never, mode: 'production', overlay: answersProbe })
    const res = await app.request('/probe', { headers: { authorization: 'Basic ' + btoa('admin:secret') } })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('overlay')
  })

  /** The precedence decision: the overlay's auth replaces the shared credential. */
  it('skips Basic auth when the overlay owns authentication', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await probe({ ...answersProbe, ownsAuth: true })

    expect(res.status).toBe(200)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/PGBOSS_DASHBOARD_AUTH_\* ignored/))
  })

  it('says nothing when there was no credential to ignore', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await probe({ ...answersProbe, ownsAuth: true })

    expect(res.status).toBe(200)
    expect(log).not.toHaveBeenCalled()
  })
})

describe('getLoadContext with an overlay', () => {
  /** A real Hono context, since the hook is handed one and may read the request. */
  async function contextFor (overlay: ProServerOverlay | null, path = '/') {
    const app = new Hono()
    let resolved: ReturnType<typeof getLoadContext> | undefined

    app.get('*', (c) => {
      resolved = getLoadContext(c, overlay)
      return c.text('ok')
    })

    await app.request(path)
    return resolved!
  }

  it('seeds the free context when there is no overlay', async () => {
    const context = await contextFor(null)

    expect(context.get(dbContext).SCHEMA).toBe('pgboss')
  })

  it('runs the overlay hook', async () => {
    const seen: string[] = []
    const context = await contextFor({ loadContext: (c) => { seen.push(new URL(c.req.url).pathname) } }, '/jobs')

    expect(seen).toEqual(['/jobs'])
    expect(context.get(dbContext).SCHEMA).toBe('pgboss')
  })

  /**
   * Ordering is the whole point: a viewer scoped to one database needs to be
   * able to override the free dashboard's choice, not merely observe it.
   */
  it('lets the overlay narrow what the free dashboard chose', async () => {
    const context = await contextFor({
      loadContext: (_c, ctx) => {
        const free = ctx.get(dbContext)
        ctx.set(dbContext, { ...free, SCHEMA: 'narrowed' })
      },
    })

    expect(context.get(dbContext).SCHEMA).toBe('narrowed')
  })
})
