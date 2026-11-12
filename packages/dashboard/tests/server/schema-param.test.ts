import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from '~/server'
import { dbContext } from '~/lib/db-context'
import type { DatabaseConfig } from '~/lib/config.server'

const seen = vi.hoisted(() => ({ schema: undefined as string | undefined }))

const createRequestHandler = vi.hoisted(() => vi.fn(() => async (_request: Request, context: { get: (key: unknown) => { currentDb: { id: string } } }) => {
  seen.schema = context.get(dbContext).currentDb.id
  return new Response('ssr')
}))

vi.mock('react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router')>(),
  createRequestHandler,
}))

const build = {
  basename: '/',
  publicPath: '/',
  assets: { url: '/assets/manifest-abc123.js', version: 'abc123', entry: { module: '/assets/entry.client-1.js', imports: [], css: [] }, routes: {} },
} as unknown as ServerBuild

const databases: DatabaseConfig[] = [
  { id: 'orders', name: 'orders', url: 'postgres://host/orders', schema: 'pgboss' },
  { id: 'billing', name: 'billing', url: 'postgres://host/billing', schema: 'jobs' },
]

const app = () => createHonoApp({ build, mode: 'production', databases, overlay: null })

describe('?db= from dashboard 1.x', () => {
  it('moves a page request to ?schema= in the same place, with a permanent redirect', async () => {
    const res = await app().request('/jobs?state=failed&db=billing&page=2')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/jobs?state=failed&schema=billing&page=2')
  })

  it('drops db when schema is also there', async () => {
    const res = await app().request('/queues?db=orders&schema=billing')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/queues?schema=billing')
  })

  it('leaves single-fetch requests and other methods to the handler', async () => {
    expect((await app().request('/jobs.data?db=billing')).status).toBe(200)
    expect((await app().request('/jobs?db=billing', { method: 'POST' })).status).toBe(200)
  })

  it('redirects under a base path', async () => {
    const res = await createHonoApp({ build, mode: 'production', basePath: '/admin', databases, overlay: null }).request('/admin/jobs?db=billing')

    expect(res.headers.get('location')).toBe('/admin/jobs?schema=billing')
  })
})

describe('?schema=', () => {
  it('selects the schema a page reads', async () => {
    await app().request('/jobs?schema=billing')
    expect(seen.schema).toBe('billing')

    await app().request('/jobs')
    expect(seen.schema).toBe('orders')
  })
})

describe('PGBOSS_SCHEMA', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('stops a dashboard that reads DATABASE_URL', () => {
    vi.stubEnv('PGBOSS_SCHEMA', 'jobs')

    expect(() => createHonoApp({ build, mode: 'production', overlay: null })).toThrow('DATABASE_URL=postgres://host/db?schema=jobs')
  })

  it('does not stop a dashboard given its schemas, or an overlay that brings its own', () => {
    vi.stubEnv('PGBOSS_SCHEMA', 'jobs')

    expect(() => createHonoApp({ build, mode: 'production', databases, overlay: null })).not.toThrow()
    expect(() => createHonoApp({ build, mode: 'production', overlay: { ownsAuth: true, server: () => {} } })).not.toThrow()
  })
})
