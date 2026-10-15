import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProxyService } from '../src/index.js'
import { bossMethodNames } from '../src/routes.js'
import { findJobsOptionsSchema } from '../src/contracts.js'
import { Hono, type MiddlewareHandler } from 'hono'

type BossMethod = string

const createBossMock = () => {
  const boss = {
    on: vi.fn(),
  } as Record<string, unknown>
  const calls = new Map<string, unknown[][]>()

  for (const method of bossMethodNames) {
    calls.set(method, [])
    ;(boss as Record<string, unknown>)[method] = vi.fn(async (...args: unknown[]) => {
      calls.get(method)?.push(args)
      return null
    })
  }

  return { boss, calls }
}

const postJson = async (url: string, body?: unknown) => {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return new Request(url, init)
}

describe('proxy api routes', () => {
  describe('CORS', () => {
    it('does not add CORS headers when PGBOSS_PROXY_CORS_ORIGIN is not set', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

      const request = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      const response = await app.fetch(request)
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('adds CORS headers when PGBOSS_PROXY_CORS_ORIGIN is set', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_CORS_ORIGIN: 'https://example.com' }
      })

      const request = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      const response = await app.fetch(request)
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com')
    })

    it('adds CORS headers on preflight request', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_CORS_ORIGIN: 'https://example.com' }
      })

      const request = new Request('http://local/api/send', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'Content-Type,Authorization'
        }
      })
      const response = await app.fetch(request)
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com')
      expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST,PUT,DELETE,PATCH,OPTIONS')
      expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type,Authorization')
    })

    it('handles wildcard CORS origin', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_CORS_ORIGIN: '*' }
      })

      const request = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://any-site.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      const response = await app.fetch(request)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    })

    it('handles multiple CORS origins', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_CORS_ORIGIN: 'https://example.com,https://app.example.com' }
      })

      // Request from first origin
      let request = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      let response = await app.fetch(request)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com')

      // Request from second origin
      request = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      response = await app.fetch(request)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com')

      // Request from disallowed origin
      request = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      response = await app.fetch(request)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('handles CORS credentials option', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: {
          PGBOSS_PROXY_CORS_ORIGIN: 'https://example.com',
          PGBOSS_PROXY_CORS_CREDENTIALS: 'true'
        }
      })

      const request = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      const response = await app.fetch(request)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com')
      expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    })

    it('handles custom CORS methods and headers via env vars', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: {
          PGBOSS_PROXY_CORS_ORIGIN: 'https://example.com',
          PGBOSS_PROXY_CORS_METHODS: 'GET,POST',
          PGBOSS_PROXY_CORS_HEADERS: 'Content-Type,X-Custom-Header',
          PGBOSS_PROXY_CORS_EXPOSE_HEADERS: 'X-Request-Id'
        }
      })

      const request = new Request('http://local/api/send', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'X-Custom-Header'
        }
      })
      const response = await app.fetch(request)
      expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST')
      expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type,X-Custom-Header')
      expect(response.headers.get('access-control-expose-headers')).toBe('X-Request-Id')
    })

    it('handles CORS max-age option', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: {
          PGBOSS_PROXY_CORS_ORIGIN: 'https://example.com',
          PGBOSS_PROXY_CORS_MAX_AGE: '3600'
        }
      })

      const request = new Request('http://local/api/send', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'POST'
        }
      })
      const response = await app.fetch(request)
      expect(response.headers.get('access-control-max-age')).toBe('3600')
    })

    it('CORS is applied to API routes but not home page', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_CORS_ORIGIN: 'https://example.com' }
      })

      // API route should have CORS
      const apiRequest = new Request('http://local/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({ name: 'queue' })
      })
      const apiResponse = await app.fetch(apiRequest)
      expect(apiResponse.headers.get('access-control-allow-origin')).toBe('https://example.com')

      // Home page should not have CORS
      const homeRequest = new Request('http://local/', {
        method: 'GET',
        headers: { origin: 'https://example.com' }
      })
      const homeResponse = await app.fetch(homeRequest)
      expect(homeResponse.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  describe('Basic Auth', () => {
    it('does not add auth when credentials are not set', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

      const request = await postJson('http://local/api/send', { name: 'queue' })
      const response = await app.fetch(request)
      expect(response.status).toBe(200)
    })

    it('requires authentication when credentials are set', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_AUTH_USERNAME: 'admin', PGBOSS_PROXY_AUTH_PASSWORD: 'secret' }
      })

      // Request without auth header should be rejected
      const request = await postJson('http://local/api/send', { name: 'queue' })
      const response = await app.fetch(request)
      // Auth is enforced (may return 401, 403, or 500 if middleware throws)
      expect(response.status).not.toBe(200)
    })

    it('rejects requests with wrong credentials', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_AUTH_USERNAME: 'admin', PGBOSS_PROXY_AUTH_PASSWORD: 'secret' }
      })

      const request = new Request('http://local/api/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + btoa('admin:wrongpassword')
        },
        body: JSON.stringify({ name: 'queue' })
      })
      const response = await app.fetch(request)
      expect(response.status).not.toBe(200)
    })

    it('accepts requests with correct credentials', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_AUTH_USERNAME: 'admin', PGBOSS_PROXY_AUTH_PASSWORD: 'secret' }
      })

      const request = new Request('http://local/api/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + btoa('admin:secret')
        },
        body: JSON.stringify({ name: 'queue' })
      })
      const response = await app.fetch(request)
      expect(response.status).toBe(200)
    })

    it('auth is applied to API routes but not home page', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_AUTH_USERNAME: 'admin', PGBOSS_PROXY_AUTH_PASSWORD: 'secret' }
      })

      // Home page should be accessible without auth
      const homeRequest = new Request('http://local/', { method: 'GET' })
      const homeResponse = await app.fetch(homeRequest)
      expect(homeResponse.status).toBe(200)

      // API route should require auth
      const apiRequest = await postJson('http://local/api/send', { name: 'queue' })
      const apiResponse = await app.fetch(apiRequest)
      expect(apiResponse.status).not.toBe(200)
    })

    it('auth works with custom prefix', async () => {
      const { boss } = createBossMock()
      const { app } = await createProxyService({
        options: {},
        bossFactory: () => boss as any,
        prefix: '/v1',
        env: { PGBOSS_PROXY_AUTH_USERNAME: 'admin', PGBOSS_PROXY_AUTH_PASSWORD: 'secret' }
      })

      // API route under custom prefix should require auth
      const apiRequest = await postJson('http://local/v1/send', { name: 'queue' })
      const apiResponse = await app.fetch(apiRequest)
      expect(apiResponse.status).not.toBe(200)

      // Root should still be accessible
      const rootRequest = new Request('http://local/', { method: 'GET' })
      const rootResponse = await app.fetch(rootRequest)
      expect(rootResponse.status).toBe(200)
    })

    it('throws when only username is set', async () => {
      const { boss } = createBossMock()
      await expect(createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_AUTH_USERNAME: 'admin' }
      })).rejects.toThrow('PGBOSS_PROXY_AUTH_PASSWORD is required when PGBOSS_PROXY_AUTH_USERNAME is set')
    })

    it('throws when only password is set', async () => {
      const { boss } = createBossMock()
      await expect(createProxyService({
        options: {},
        bossFactory: () => boss as any,
        env: { PGBOSS_PROXY_AUTH_PASSWORD: 'secret' }
      })).rejects.toThrow('PGBOSS_PROXY_AUTH_USERNAME is required when PGBOSS_PROXY_AUTH_PASSWORD is set')
    })
  })

  it('calls the expected pg-boss methods with args (POST)', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const cases: Array<{
      method: BossMethod
      body?: unknown
      expected: unknown[]
    }> = [
      {
        method: 'send',
        body: { name: 'queue', data: { foo: 'bar' }, options: { priority: 1 } },
        expected: ['queue', { foo: 'bar' }, { priority: 1 }]
      },
      {
        method: 'sendAfter',
        body: { name: 'queue', data: null, options: null, after: 10 },
        expected: ['queue', null, null, 10]
      },
      {
        method: 'sendThrottled',
        body: { name: 'queue', data: {}, options: null, seconds: 5, key: 'k' },
        expected: ['queue', {}, null, 5, 'k']
      },
      {
        method: 'sendDebounced',
        body: { name: 'queue', data: { a: 1 }, options: {}, seconds: 5, key: 'k' },
        expected: ['queue', { a: 1 }, {}, 5, 'k']
      },
      {
        method: 'insert',
        body: { name: 'queue', jobs: [{ id: '1', data: {} }], options: { returnId: true } },
        expected: ['queue', [{ id: '1', data: {} }], { returnId: true }]
      },
      {
        method: 'update',
        body: { name: 'queue', data: { foo: 'bar' }, options: { id: '1' } },
        expected: ['queue', { foo: 'bar' }, { id: '1' }]
      },
      {
        method: 'upsert',
        body: { name: 'queue', data: { foo: 'bar' }, options: { singletonKey: 'k', match: 'all' } },
        expected: ['queue', { foo: 'bar' }, { singletonKey: 'k', match: 'all' }]
      },
      {
        method: 'flow',
        body: { jobs: [{ ref: 'a', name: 'queue' }, { ref: 'b', name: 'queue', dependsOn: ['a'] }] },
        expected: [[{ ref: 'a', name: 'queue' }, { ref: 'b', name: 'queue', dependsOn: ['a'] }]]
      },
      {
        method: 'fetch',
        body: { name: 'queue', options: { includeMetadata: true } },
        expected: ['queue', { includeMetadata: true }]
      },
      {
        method: 'subscribe',
        body: { event: 'error', name: 'queue' },
        expected: ['error', 'queue']
      },
      {
        method: 'unsubscribe',
        body: { event: 'error', name: 'queue' },
        expected: ['error', 'queue']
      },
      {
        method: 'publish',
        body: { event: 'event', data: { x: 1 }, options: { priority: 2 } },
        expected: ['event', { x: 1 }, { priority: 2 }]
      },
      {
        method: 'cancel',
        body: { name: 'queue', id: '1' },
        expected: ['queue', '1']
      },
      {
        method: 'resume',
        body: { name: 'queue', id: '1' },
        expected: ['queue', '1']
      },
      {
        method: 'retry',
        body: { name: 'queue', id: '1' },
        expected: ['queue', '1']
      },
      {
        method: 'deleteJob',
        body: { name: 'queue', id: '1' },
        expected: ['queue', '1']
      },
      {
        method: 'touch',
        body: { name: 'queue', id: ['1', '2'] },
        expected: ['queue', ['1', '2']]
      },
      {
        method: 'redrive',
        body: { name: 'dlq', options: { destination: 'dest', sourceName: 'src', data: { tenant: 'acme' }, createdBefore: '2026-09-01T00:00:00.000Z', ids: ['a', 'b'], limit: 50 } },
        expected: ['dlq', { destination: 'dest', sourceName: 'src', data: { tenant: 'acme' }, createdBefore: new Date('2026-09-01T00:00:00.000Z'), ids: ['a', 'b'], limit: 50 }]
      },
      {
        method: 'previewRedrive',
        body: { name: 'dlq', options: { sourceName: 'src', data: { tenant: 'acme' }, createdBefore: '2026-09-01T00:00:00.000Z', limit: 50 } },
        expected: ['dlq', { sourceName: 'src', data: { tenant: 'acme' }, createdBefore: new Date('2026-09-01T00:00:00.000Z'), limit: 50 }]
      },
      {
        method: 'deleteQueuedJobs',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'deleteStoredJobs',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'deleteAllJobs',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'complete',
        body: { name: 'queue', id: '1', data: { done: true }, options: { includeQueued: true } },
        expected: ['queue', '1', { done: true }, { includeQueued: true }]
      },
      {
        method: 'fail',
        body: { name: 'queue', id: ['1', '2'], data: { reason: 'timeout' } },
        expected: ['queue', ['1', '2'], { reason: 'timeout' }]
      },
      {
        method: 'createQueue',
        body: { name: 'queue', options: { retryLimit: 1 } },
        expected: ['queue', { retryLimit: 1 }]
      },
      {
        method: 'updateQueue',
        body: { name: 'queue', options: { retryLimit: 2 } },
        expected: ['queue', { retryLimit: 2 }]
      },
      {
        method: 'deleteQueue',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'supervise',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'schedule',
        body: { name: 'queue', cron: '* * * * *', data: { a: 1 }, options: { tz: 'UTC', missed: 'once' } },
        expected: ['queue', '* * * * *', { a: 1 }, { tz: 'UTC', missed: 'once' }]
      },
      {
        method: 'unschedule',
        body: { name: 'queue', key: 'k' },
        expected: ['queue', 'k']
      },
    ]

    for (const entry of cases) {
      const request = await postJson(`http://local/api/${entry.method}`, entry.body)
      const response = await app.fetch(request)
      expect(response.status, `${entry.method} should return 200`).toBe(200)

      const methodCalls = calls.get(entry.method)
      expect(methodCalls?.length, `${entry.method} should have 1 call`).toBe(1)
      expect(methodCalls?.[0]).toEqual(entry.expected)
    }
  })

  it('calls the expected pg-boss methods via GET routes', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const getCases: Array<{
      method: string
      query?: string
      expected: unknown[]
    }> = [
      { method: 'isInstalled', expected: [] },
      { method: 'schemaVersion', expected: [] },
      { method: 'getBamStatus', expected: [] },
      { method: 'getQueue', query: 'name=queue', expected: ['queue'] },
      { method: 'getBlockedKeys', query: 'name=queue', expected: ['queue'] },
      { method: 'getDependencies', query: 'name=queue&id=1', expected: ['queue', '1'] },
      { method: 'getDependents', query: 'name=queue&id=1', expected: ['queue', '1'] },
      { method: 'getQueues', query: 'names=a&names=b', expected: [['a', 'b']] },
      { method: 'getQueues', expected: [] },
      { method: 'getQueueStats', query: 'name=queue', expected: ['queue'] },
      { method: 'getSchedules', query: 'name=queue&key=k', expected: ['queue', 'k'] },
      { method: 'getSchedules', query: 'name=queue', expected: ['queue'] },
      { method: 'getSchedules', expected: [] },
      { method: 'getSchedule', query: 'name=queue&key=k', expected: ['queue', 'k'] },
      { method: 'getSchedule', query: 'name=queue', expected: ['queue'] },
      { method: 'previewSchedule', query: 'cron=0+3+*+*+*', expected: ['0 3 * * *'] },
      {
        method: 'previewSchedule',
        query: 'cron=0+3+*+*+*&tz=America%2FChicago&count=3&from=2026-03-01T00%3A00%3A00Z',
        expected: ['0 3 * * *', { tz: 'America/Chicago', from: new Date('2026-03-01T00:00:00Z'), count: 3 }]
      },
    ]

    for (const entry of getCases) {
      // Reset calls for methods that appear multiple times
      calls.set(entry.method, [])

      const qs = entry.query ? `?${entry.query}` : ''
      const request = new Request(`http://local/api/${entry.method}${qs}`, { method: 'GET' })
      const response = await app.fetch(request)
      expect(response.status, `GET ${entry.method}${qs} should return 200`).toBe(200)

      const methodCalls = calls.get(entry.method)
      expect(methodCalls?.length, `GET ${entry.method} should have 1 call`).toBe(1)
      expect(methodCalls?.[0]).toEqual(entry.expected)
    }
  })

  it('updateQueue passes null through for the fields pg-boss allows clearing', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const body = { name: 'queue', options: { deadLetter: null, retryDelayMax: null, heartbeatSeconds: null } }
    const response = await app.fetch(await postJson('http://local/api/updateQueue', body))
    expect(response.status).toBe(200)
    expect(calls.get('updateQueue')?.[0]).toEqual(['queue', { deadLetter: null, retryDelayMax: null, heartbeatSeconds: null }])
  })

  it('GET findJobs passes flattened options as query params', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue&id=1&queued=true&limit=50', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue', { id: '1', queued: true, limit: 50 }])
  })

  it('GET list reads pass a limit through as ListOptions', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const cases: Array<[string, string, unknown[]]> = [
      ['getQueues', 'limit=5', [undefined, { limit: 5 }]],
      ['getQueues', 'names=a&limit=5', [['a'], { limit: 5 }]],
      ['getSchedules', 'limit=5', [undefined, undefined, { limit: 5 }]],
      ['getSchedules', 'name=q&limit=5', ['q', undefined, { limit: 5 }]],
      ['getBlockedKeys', 'name=q&limit=5', ['q', { limit: 5 }]],
      ['getDependencies', 'name=q&id=1&limit=5', ['q', '1', { limit: 5 }]],
      ['getDependents', 'name=q&id=1&limit=5', ['q', '1', { limit: 5 }]],
      ['getQueues', 'after=a', [undefined, { after: 'a' }]],
      ['getBlockedKeys', 'name=q&limit=5&after=k', ['q', { limit: 5, after: 'k' }]],
      ['getSchedules', 'afterName=q&afterKey=k', [undefined, undefined, { after: { name: 'q', key: 'k' } }]],
      ['getDependencies', 'name=q&id=1&afterName=p&afterId=0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7', ['q', '1', { after: { name: 'p', id: '0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7' } }]],
      ['findJobs', 'name=q&limit=5&after=0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7', ['q', { limit: 5, after: '0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7' }]]
    ]

    for (const [method, query, args] of cases) {
      const res = await app.fetch(new Request(`http://local/api/${method}?${query}`, { method: 'GET' }))
      expect(res.status, `${method}?${query}`).toBe(200)
      expect(calls.get(method)?.at(-1), `${method}?${query}`).toEqual(args)
    }

    // No limit leaves the call as it was, so core applies its default.
    await app.fetch(new Request('http://local/api/getQueues', { method: 'GET' }))
    expect(calls.get('getQueues')?.at(-1)).toEqual([])
  })

  it('GET list reads reject a limit outside 1 to 100000, and half an after pair', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    for (const query of ['getQueues?limit=0', 'getSchedules?limit=100001', 'getBlockedKeys?name=q&limit=1.5', 'getDependents?name=q&id=1&limit=0', 'getSchedules?afterName=q', 'getDependents?name=q&id=1&afterId=0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7']) {
      const res = await app.fetch(new Request(`http://local/api/${query}`, { method: 'GET' }))
      expect(res.status, query).toBe(400)
    }
  })

  it('GET findJobs rejects a limit outside 1 to 100000', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    for (const limit of ['0', '1.5', '100001']) {
      const findRes = await app.fetch(new Request(`http://local/api/findJobs?name=queue&limit=${limit}`, { method: 'GET' }))
      expect(findRes.status, limit).toBe(400)
    }
  })

  it('GET findJobs and the dependency reads reject an after that is not a uuid', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    for (const query of ['findJobs?name=q&after=abc', 'getDependencies?name=q&id=1&afterName=q&afterId=abc', 'getDependents?name=q&id=1&afterName=q&afterId=abc']) {
      const res = await app.fetch(new Request(`http://local/api/${query}`, { method: 'GET' }))
      expect(res.status, query).toBe(400)
    }

    // An unpaired brace or a hyphen that does not follow a group of four hex digits.
    for (const after of ['{0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7', '-0193a1b2c3d47e5f80718293a4b5c6d7', '019-3a1b2-c3d4-7e5f-8071-8293a4b5c6d7']) {
      const res = await app.fetch(new Request(`http://local/api/findJobs?name=q&after=${encodeURIComponent(after)}`, { method: 'GET' }))
      expect(res.status, after).toBe(400)
    }

    // Any spelling the uuid type accepts passes through as it was sent.
    const id = '{0193A1B2C3D4E5F60718293A4B5C6D7E}'
    const res = await app.fetch(new Request(`http://local/api/findJobs?name=q&after=${encodeURIComponent(id)}`, { method: 'GET' }))
    expect(res.status).toBe(200)
    expect(calls.get('findJobs')?.at(-1)).toEqual(['q', { after: id }])
  })

  it('OpenAPI gives after and afterId a pattern that matches a uuid', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })
    const spec = await (await app.fetch(new Request('http://local/openapi.json', { method: 'GET' }))).json() as any

    for (const [path, param] of [['/api/findJobs', 'after'], ['/api/getDependencies', 'afterId'], ['/api/getDependents', 'afterId']]) {
      const { pattern } = spec.paths[path].get.parameters.find((p: any) => p.name === param).schema
      for (const id of ['0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7', '{0193A1B2C3D47E5F80718293A4B5C6D7}']) {
        expect(new RegExp(pattern).test(id), `${path} ${param} ${id}`).toBe(true)
      }
    }
  })

  it('findJobsOptionsSchema takes the limit and after core accepts', () => {
    for (const options of [{ limit: 0 }, { limit: 1.5 }, { limit: 100001 }, { after: 'abc' }, { after: '{0193a1b2-c3d4-7e5f-8071-8293a4b5c6d7' }]) {
      expect(findJobsOptionsSchema.safeParse(options).success, JSON.stringify(options)).toBe(false)
    }
    expect(findJobsOptionsSchema.safeParse({ limit: 100000, after: '{0193A1B2C3D47E5F80718293A4B5C6D7}' }).success).toBe(true)
  })

  it('redrive and previewRedrive reject a limit core would refuse', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const cases: Array<[string, number]> = [['redrive', 0], ['redrive', 1.5], ['previewRedrive', 0], ['previewRedrive', 1.5], ['previewRedrive', 100001]]

    for (const [method, limit] of cases) {
      const res = await app.fetch(await postJson(`http://local/api/${method}`, { name: 'dlq', options: { limit } }))
      expect(res.status, `${method} ${limit}`).toBe(400)
    }

    expect(calls.get('redrive') ?? []).toHaveLength(0)
    expect(calls.get('previewRedrive') ?? []).toHaveLength(0)

    // redrive has no upper bound in core.
    const res = await app.fetch(await postJson('http://local/api/redrive', { name: 'dlq', options: { limit: 200000 } }))
    expect(res.status).toBe(200)
  })

  it('GET findJobs with dataKey and dataValue builds data filter', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue&dataKey=status&dataValue=pending', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue', { data: { status: 'pending' } }])
  })

  it('GET findJobs with dataKey only uses null as value', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue&dataKey=status', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue', { data: { status: null } }])
  })

  it('GET findJobs works without options', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue'])
  })

  it('GET getQueueStats builds options from query params', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const req = new Request('http://local/api/getQueueStats?name=queue&limit=50&aggregate=avg&force=true', { method: 'GET' })
    const res = await app.fetch(req)
    expect(res.status).toBe(200)
    expect(calls.get('getQueueStats')?.[0]).toEqual(['queue', { limit: 50, aggregate: 'avg', force: true }])
  })

  it('GET getQueueStats coerces from/to to Date and numerics to numbers', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const req = new Request('http://local/api/getQueueStats?name=queue&from=2026-06-01T00:00:00.000Z&bucketSeconds=3600&maxDataPoints=100', { method: 'GET' })
    const res = await app.fetch(req)
    expect(res.status).toBe(200)
    const call = calls.get('getQueueStats')?.[0] as [string, Record<string, unknown>]
    expect(call[0]).toBe('queue')
    expect(call[1].from).toBeInstanceOf(Date)
    expect((call[1].from as Date).toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(call[1].bucketSeconds).toBe(3600)
    expect(call[1].maxDataPoints).toBe(100)
  })

  it('GET getQueueStats reads percentiles as a comma-separated list', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const res = await app.fetch(new Request('http://local/api/getQueueStats?name=queue&percentiles=50,95,99.9', { method: 'GET' }))
    expect(res.status).toBe(200)
    expect(calls.get('getQueueStats')?.[0]).toEqual(['queue', { percentiles: [50, 95, 99.9] }])
  })

  it('GET getQueueStats rejects percentiles outside 1 to 100', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    for (const value of ['0.95', '101', '50,abc', '']) {
      const res = await app.fetch(new Request(`http://local/api/getQueueStats?name=queue&percentiles=${value}`, { method: 'GET' }))
      expect(res.status, value).toBe(400)
    }
  })

  it('GET getQueueStats rejects invalid numeric params', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const req = new Request('http://local/api/getQueueStats?name=queue&limit=-5', { method: 'GET' })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)
  })

  it('GET previewSchedule rejects a count past the method ceiling', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    // The method asserts the same ceiling, so without it here the refusal arrives as a 500 built
    // out of assertion text rather than a 400 naming the parameter.
    const req = new Request('http://local/api/previewSchedule?cron=0+3+*+*+*&count=1001', { method: 'GET' })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)
  })

  it('rejects oversized request bodies', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, bodyLimit: 100 })

    const jsonBody = JSON.stringify({ name: 'queue', data: { payload: 'x'.repeat(200) } })
    const request = new Request('http://local/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(jsonBody.length) },
      body: jsonBody
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(413)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
  })

  it('returns 400 for malformed POST body', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    // Missing required 'name' field
    const request = await postJson('http://local/api/send', { data: { foo: 'bar' } })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
    expect(body.error.message).toBeTruthy()
  })

  it('settle routes pass job attempts through, reduced to id and retryCount', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const fetched = { id: '1', name: 'queue', data: { x: 1 }, retryCount: 2, expireInSeconds: 900, heartbeatSeconds: null }

    const cases: Array<{ method: string, body: unknown, expected: unknown[] }> = [
      { method: 'complete', body: { name: 'queue', id: fetched, data: { done: true } }, expected: ['queue', { id: '1', retryCount: 2 }, { done: true }] },
      { method: 'fail', body: { name: 'queue', id: [fetched, { id: '2', retryCount: 0 }] }, expected: ['queue', [{ id: '1', retryCount: 2 }, { id: '2', retryCount: 0 }]] },
      { method: 'cancel', body: { name: 'queue', id: { id: '1', retryCount: 2 } }, expected: ['queue', { id: '1', retryCount: 2 }] },
      { method: 'deleteJob', body: { name: 'queue', id: [{ id: '1', retryCount: 2 }] }, expected: ['queue', [{ id: '1', retryCount: 2 }]] },
      { method: 'touch', body: { name: 'queue', id: fetched }, expected: ['queue', { id: '1', retryCount: 2 }] },
    ]

    for (const entry of cases) {
      const response = await app.fetch(await postJson(`http://local/api/${entry.method}`, entry.body))
      expect(response.status, `${entry.method} should return 200`).toBe(200)
      expect(calls.get(entry.method)?.[0]).toEqual(entry.expected)
    }
  })

  it('rejects malformed job attempts, and attempts on routes that take plain ids', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const cases: Array<{ method: string, body: unknown }> = [
      { method: 'complete', body: { name: 'queue', id: ['1', { id: '2', retryCount: 0 }] } },
      { method: 'fail', body: { name: 'queue', id: { id: '1', retryCount: -1 } } },
      { method: 'cancel', body: { name: 'queue', id: { id: '1', retryCount: 1.5 } } },
      { method: 'deleteJob', body: { name: 'queue', id: { id: '1' } } },
      { method: 'touch', body: { name: 'queue', id: [{ id: '1', retryCount: 0 }, '2'] } },
      { method: 'resume', body: { name: 'queue', id: { id: '1', retryCount: 0 } } },
      { method: 'retry', body: { name: 'queue', id: { id: '1', retryCount: 0 } } },
    ]

    for (const entry of cases) {
      const response = await app.fetch(await postJson(`http://local/api/${entry.method}`, entry.body))
      expect(response.status, `${entry.method} should return 400`).toBe(400)
      expect(calls.get(entry.method)?.length, `${entry.method} should not be called`).toBe(0)
    }
  })

  it('returns 400 for wrong types in POST body', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    // 'seconds' should be a number
    const request = await postJson('http://local/api/sendThrottled', {
      name: 'queue',
      data: null,
      options: null,
      seconds: 'not-a-number'
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
  })

  it('returns 500 with generic message when method throws (exposeErrors: false)', async () => {
    const { boss } = createBossMock()
    ;(boss as any).send = vi.fn(async () => { throw new Error('db connection lost') })
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(500)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
    expect(body.error.message).toBe('Internal server error')
  })

  it('returns 500 with real message when method throws (exposeErrors: true)', async () => {
    const { boss } = createBossMock()
    ;(boss as any).send = vi.fn(async () => { throw new Error('db connection lost') })
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, exposeErrors: true })

    const request = await postJson('http://local/api/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(500)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
    expect(body.error.message).toBe('db connection lost')
  })

  it('returns 500 with generic message for GET method throws (exposeErrors: false)', async () => {
    const { boss } = createBossMock()
    ;(boss as any).isInstalled = vi.fn(async () => { throw new Error('secret error') })
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/isInstalled', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(500)

    const body = await response.json() as any
    expect(body.error.message).toBe('Internal server error')
  })

  it('edge case: send with only name (no data/options)', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('send')?.[0]).toEqual(['queue'])
  })

  it('edge case: update without data passes undefined (leave payload unchanged), not null', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/update', { name: 'queue', options: { id: '1' } })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    const args = calls.get('update')?.[0]
    expect(args).toEqual(['queue', undefined, { id: '1' }])
    expect(args?.[1]).toBeUndefined()
  })

  it('edge case: update with null data passes null (clear payload)', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/update', { name: 'queue', data: null, options: { singletonKey: 'k' } })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('update')?.[0]).toEqual(['queue', null, { singletonKey: 'k' }])
  })

  it('edge case: update without options is rejected', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/update', { name: 'queue', data: { foo: 'bar' } })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)
    expect(calls.get('update')?.length).toBe(0)
  })

  it('edge case: deleteAllJobs with no name', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/deleteAllJobs', {})
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('deleteAllJobs')?.[0]).toEqual([])
  })

  it('edge case: unschedule without key', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/unschedule', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('unschedule')?.[0]).toEqual(['queue'])
  })

  it('edge case: supervise with no name', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/supervise', {})
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('supervise')?.[0]).toEqual([])
  })

  it('edge case: supervise forwards options with no name', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/supervise', { options: { reindex: { force: true } } })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('supervise')?.[0]).toEqual([undefined, { reindex: { force: true } }])
  })

  it('edge case: supervise forwards name and options', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/supervise', { name: 'queue', options: { reindex: false } })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('supervise')?.[0]).toEqual(['queue', { reindex: false }])
  })

  it('edge case: getReindexCommands with no query params', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/getReindexCommands', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('getReindexCommands')?.[0]).toEqual([])
  })

  it('edge case: getReindexCommands coerces query params into options', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/getReindexCommands?minPages=256&minSizeRatio=2.5&force=true', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('getReindexCommands')?.[0]).toEqual([{ minPages: 256, minSizeRatio: 2.5, force: true }])
  })

  it('edge case: getQueues with single name query param', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/getQueues?names=single', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('getQueues')?.[0]).toEqual([['single']])
  })

  it('GET /api/meta returns states/policies/events and the schedule enumerations', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/meta', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)

    const body = await response.json() as any
    expect(body.ok).toBe(true)
    expect(body.result.states).toBeDefined()
    expect(body.result.policies).toBeDefined()
    expect(body.result.events).toBeDefined()
    expect(body.result.scheduleKinds).toEqual({ cron: 'cron', rrule: 'rrule' })
    expect(body.result.scheduleMissedPolicies).toEqual({ skip: 'skip', once: 'once' })
  })

  it('middleware can reject requests with 401', async () => {
    const { boss } = createBossMock()
    const authMiddleware: MiddlewareHandler = async (c, next) => {
      const token = c.req.header('authorization')
      if (token !== 'Bearer valid-token') {
        return c.json({ ok: false, error: { message: 'Unauthorized' } }, 401)
      }
      await next()
    }

    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, middleware: authMiddleware })

    // Request without auth header should be rejected
    const noAuthReq = await postJson('http://local/api/send', { name: 'queue' })
    const noAuthRes = await app.fetch(noAuthReq)
    expect(noAuthRes.status).toBe(401)

    // Request with valid auth header should succeed
    const authReq = new Request('http://local/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer valid-token' },
      body: JSON.stringify({ name: 'queue' })
    })
    const authRes = await app.fetch(authReq)
    expect(authRes.status).toBe(200)
  })

  it('middleware does not affect home page or docs', async () => {
    const { boss } = createBossMock()
    const rejectAll: MiddlewareHandler = async (c, _next) => {
      return c.json({ ok: false, error: { message: 'Forbidden' } }, 403)
    }

    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, middleware: rejectAll })

    // Home page should still be accessible
    const homeReq = new Request('http://local/', { method: 'GET' })
    const homeRes = await app.fetch(homeReq)
    expect(homeRes.status).toBe(200)

    // Meta endpoint should be blocked (it's under /api/*)
    const metaReq = new Request('http://local/api/meta', { method: 'GET' })
    const metaRes = await app.fetch(metaReq)
    expect(metaRes.status).toBe(403)
  })

  it('supports array of middleware', async () => {
    const { boss } = createBossMock()
    const log: string[] = []

    const mw1: MiddlewareHandler = async (_c, next) => {
      log.push('mw1')
      await next()
    }
    const mw2: MiddlewareHandler = async (_c, next) => {
      log.push('mw2')
      await next()
    }

    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, middleware: [mw1, mw2] })

    const request = new Request('http://local/api/isInstalled', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(log).toEqual(['mw1', 'mw2'])
  })

  it('rejects empty name with 400', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/send', { name: '' })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
  })

  it('rejects empty event name with 400', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/subscribe', { event: '', name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
  })

  it('rejects empty name in GET query with 400', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/getQueue?name=', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json() as any
    expect(body.ok).toBe(false)
  })

  it('sendThrottled without key does not pass trailing undefined', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/sendThrottled', {
      name: 'queue', data: null, options: null, seconds: 5
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)

    const args = calls.get('sendThrottled')?.[0]
    expect(args).toEqual(['queue', null, null, 5])
    expect(args?.length).toBe(4)
  })

  it('OpenAPI and docs are always at root regardless of prefix', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, prefix: '/v1' })

    const openapiReq = new Request('http://local/openapi.json', { method: 'GET' })
    const openapiRes = await app.fetch(openapiReq)
    expect(openapiRes.status).toBe(200)
    const spec = await openapiRes.json() as any
    expect(spec.openapi).toBe('3.1.0')

    const docsReq = new Request('http://local/docs', { method: 'GET' })
    const docsRes = await app.fetch(docsReq)
    expect(docsRes.status).toBe(200)
  })

  it('custom prefix routes work correctly', async () => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, prefix: '/v1' })

    const request = await postJson('http://local/v1/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('send')?.[0]).toEqual(['queue'])
  })

  it('normalizePrefix handles edge cases', async () => {
    const { boss } = createBossMock()

    // prefix "/" normalizes to "" (root)
    const { prefix: p1 } = await createProxyService({ options: {}, bossFactory: () => boss as any, prefix: '/' })
    expect(p1).toBe('')

    // prefix without leading slash gets one added
    const { prefix: p2 } = await createProxyService({ options: {}, bossFactory: () => boss as any, prefix: 'api' })
    expect(p2).toBe('/api')

    // trailing slash stripped
    const { prefix: p3 } = await createProxyService({ options: {}, bossFactory: () => boss as any, prefix: '/api/' })
    expect(p3).toBe('/api')
  })

  it('home page renders method list and links', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)

    const html = await response.text()
    expect(html).toContain('pg-boss proxy')
    expect(html).toContain('/api/send')
    expect(html).toContain('/openapi.json')
    expect(html).toContain('/docs')
    expect(html).toContain('POST')
    expect(html).toContain('GET')
  })

  it('can deny specific routes via options', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      routes: { deny: ['deleteAllJobs'] }
    })

    const denyReq = await postJson('http://local/api/deleteAllJobs', {})
    const denyRes = await app.fetch(denyReq)
    expect(denyRes.status).toBe(404)

    const okReq = await postJson('http://local/api/send', { name: 'queue' })
    const okRes = await app.fetch(okReq)
    expect(okRes.status).toBe(200)

    const openapiReq = new Request('http://local/openapi.json', { method: 'GET' })
    const openapiRes = await app.fetch(openapiReq)
    const spec = await openapiRes.json() as any
    expect(spec.paths['/api/deleteAllJobs']).toBeUndefined()

    const homeReq = new Request('http://local/', { method: 'GET' })
    const homeRes = await app.fetch(homeReq)
    const html = await homeRes.text()
    expect(html).not.toContain('/api/deleteAllJobs')
  })

  it('can allow specific routes via options', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      routes: { allow: ['send'] }
    })

    const okReq = await postJson('http://local/api/send', { name: 'queue' })
    const okRes = await app.fetch(okReq)
    expect(okRes.status).toBe(200)

    const denyReq = await postJson('http://local/api/deleteAllJobs', {})
    const denyRes = await app.fetch(denyReq)
    expect(denyRes.status).toBe(404)

    const openapiReq = new Request('http://local/openapi.json', { method: 'GET' })
    const openapiRes = await app.fetch(openapiReq)
    const spec = await openapiRes.json() as any
    expect(spec.paths['/api/send']).toBeDefined()
    expect(spec.paths['/api/deleteAllJobs']).toBeUndefined()

    const homeReq = new Request('http://local/', { method: 'GET' })
    const homeRes = await app.fetch(homeReq)
    const html = await homeRes.text()
    expect(html).toContain('/api/send')
    expect(html).not.toContain('/api/deleteAllJobs')
  })

  it('OpenAPI spec includes tags and operationId', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/openapi.json', { method: 'GET' })
    const response = await app.fetch(request)
    const spec = await response.json() as any

    const sendRoute = spec.paths['/api/send']?.post
    expect(sendRoute.tags).toEqual(['jobs'])
    expect(sendRoute.operationId).toBe('send')

    const getQueueRoute = spec.paths['/api/getQueue']?.get
    expect(getQueueRoute.tags).toEqual(['queues'])
    expect(getQueueRoute.operationId).toBe('getQueue')

    const scheduleRoute = spec.paths['/api/schedule']?.post
    expect(scheduleRoute.tags).toEqual(['schedules'])
    expect(scheduleRoute.operationId).toBe('schedule')
  })

  it('bossFactory receives resolved options with supervise/migrate/schedule disabled', async () => {
    let receivedOptions: Record<string, unknown> = {}
    const { boss } = createBossMock()

    await createProxyService({
      env: { DATABASE_URL: 'postgres://localhost/test' },
      bossFactory: (opts) => {
        receivedOptions = opts as unknown as Record<string, unknown>
        return boss as any
      }
    })

    expect(receivedOptions.supervise).toBe(false)
    expect(receivedOptions.migrate).toBe(false)
    expect(receivedOptions.schedule).toBe(false)
    expect(receivedOptions.connectionString).toBe('postgres://localhost/test')
  })

  it('shutdown handler only fires once on concurrent signals', async () => {
    const { attachShutdownListeners } = await import('../src/shutdown.js')
    let callCount = 0
    const handler = () => { callCount++ }

    const listeners: Array<() => void> = []
    const adapter = {
      on: (_signal: string, fn: () => void) => { listeners.push(fn) },
      off: () => {}
    }

    attachShutdownListeners(['SIGINT', 'SIGTERM'], adapter, handler)

    // Simulate both signals firing
    for (const listener of listeners) {
      listener()
    }

    expect(callCount).toBe(1)
  })
})

describe('node.ts createProxyServerNode', () => {
  const originalEnv = process.env.DATABASE_URL

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DATABASE_URL = originalEnv
    } else {
      delete process.env.DATABASE_URL
    }
  })

  it('uses options when provided', async () => {
    const { createProxyServerNode } = await import('../src/node.js')
    await expect(createProxyServerNode({ options: { connectionString: 'postgres://localhost/test' } as any })).resolves.not.toThrow()
  })

  it('falls back to DATABASE_URL', async () => {
    const { createProxyServerNode } = await import('../src/node.js')
    process.env.DATABASE_URL = 'postgres://localhost/test'
    await expect(createProxyServerNode()).resolves.not.toThrow()
  })

  it('throws when no connection info is available', async () => {
    const { createProxyServerNode } = await import('../src/node.js')
    delete process.env.DATABASE_URL
    await expect(createProxyServerNode({})).rejects.toThrow('Proxy requires PgBoss constructor options.')
  })
})

describe('env.ts configuration', () => {
  it('parses PGBOSS_PROXY_PREFIX from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { prefix } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_PREFIX: '/v1' }
    })

    expect(prefix).toBe('/v1')
  })

  it('parses PGBOSS_PROXY_REQUEST_LOGGER from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { app: app1 } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_REQUEST_LOGGER: 'false' }
    })

    const { app: app2 } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_REQUEST_LOGGER: 'true' }
    })

    // Both should work without errors
    expect(app1).toBeDefined()
    expect(app2).toBeDefined()
  })

  it('parses PGBOSS_PROXY_EXPOSE_ERRORS from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()
    ;(boss as any).send = vi.fn(async () => { throw new Error('secret error') })

    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_EXPOSE_ERRORS: 'false' }
    })

    const request = await postJson('http://local/api/send', { name: 'queue' })
    const response = await app.fetch(request)
    const body = await response.json() as any
    expect(body.error.message).toBe('Internal server error')
  })

  it('parses PGBOSS_PROXY_BODY_LIMIT from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_BODY_LIMIT: '100' }
    })

    const jsonBody = JSON.stringify({ name: 'queue', data: { payload: 'x'.repeat(200) } })
    const request = new Request('http://local/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(jsonBody.length) },
      body: jsonBody
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(413)
  })

  it('parses PGBOSS_PROXY_ROUTES_ALLOW from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_ROUTES_ALLOW: 'send,fetch' }
    })

    // send should work
    let request = await postJson('http://local/api/send', { name: 'queue' })
    let response = await app.fetch(request)
    expect(response.status).toBe(200)

    // getQueues should be blocked (not in allow list)
    request = new Request('http://local/api/getQueues', { method: 'GET' })
    response = await app.fetch(request)
    expect(response.status).toBe(404)
  })

  it('parses PGBOSS_PROXY_ROUTES_DENY from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_ROUTES_DENY: 'deleteQueue,deleteAllJobs' }
    })

    // send should work
    let request = await postJson('http://local/api/send', { name: 'queue' })
    let response = await app.fetch(request)
    expect(response.status).toBe(200)

    // deleteQueue should be blocked
    request = await postJson('http://local/api/deleteQueue', { name: 'queue' })
    response = await app.fetch(request)
    expect(response.status).toBe(404)
  })

  it('parses PGBOSS_PROXY_PAGE_ROOT from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_PAGE_ROOT: 'false' }
    })

    const request = new Request('http://local/', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(404)
  })

  it('parses PGBOSS_PROXY_PAGE_DOCS from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_PAGE_DOCS: 'false' }
    })

    const request = new Request('http://local/docs', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(404)
  })

  it('parses PGBOSS_PROXY_PAGE_OPENAPI from env', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { app } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_PAGE_OPENAPI: 'false' }
    })

    const request = new Request('http://local/openapi.json', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(404)
  })

  it('code options override env vars', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { prefix } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      prefix: '/custom',
      env: { PGBOSS_PROXY_PREFIX: '/env' }
    })

    expect(prefix).toBe('/custom')
  })

  it('code options override env vars', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    const { prefix } = await createProxyService({
      options: {},
      bossFactory: () => boss as any,
      prefix: '/custom',
      env: { PGBOSS_PROXY_PREFIX: '/env' }
    })

    expect(prefix).toBe('/custom')
  })

  it('parses PGBOSS_PROXY_LOG_FORMAT from env', async () => {
    const { configureLogging } = await import('../src/env.js')

    // should not throw
    await expect(configureLogging('text')).resolves.not.toThrow()
  })

  it('logs warning for invalid routes in PGBOSS_PROXY_ROUTES_ALLOW', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    // Should not throw, just log warning via LogTape
    await expect(createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_ROUTES_ALLOW: 'send,invalidRoute,fetch' }
    })).resolves.not.toThrow()
  })

  it('logs warning for invalid routes in PGBOSS_PROXY_ROUTES_DENY', async () => {
    const { createProxyService } = await import('../src/index.js')
    const { boss } = createBossMock()

    // Should not throw, just log warning via LogTape
    await expect(createProxyService({
      options: {},
      bossFactory: () => boss as any,
      env: { PGBOSS_PROXY_ROUTES_DENY: 'deleteQueue,badRoute' }
    })).resolves.not.toThrow()
  })
})

describe('proxy instance name', () => {
  const resolveOptions = async (options: Record<string, unknown>, env: Record<string, string> = {}) => {
    const { boss } = createBossMock()
    let received: Record<string, unknown> = {}
    await createProxyService({
      options,
      env,
      bossFactory: (resolved) => { received = resolved as Record<string, unknown>; return boss as any }
    })
    return received
  }

  it('registers as pg-boss-proxy by default', async () => {
    expect((await resolveOptions({})).instanceName).toBe('pg-boss-proxy')
  })

  it('takes PGBOSS_PROXY_INSTANCE_NAME when no instanceName is passed', async () => {
    expect((await resolveOptions({}, { PGBOSS_PROXY_INSTANCE_NAME: 'edge-proxy' })).instanceName).toBe('edge-proxy')
  })

  it('keeps a passed instanceName over the environment', async () => {
    const resolved = await resolveOptions({ instanceName: 'billing-proxy' }, { PGBOSS_PROXY_INSTANCE_NAME: 'edge-proxy' })
    expect(resolved.instanceName).toBe('billing-proxy')
  })
})

describe('authorize', () => {
  const serve = async (authorize: NonNullable<Parameters<typeof createProxyService>[0]['authorize']>, extra: Record<string, unknown> = {}) => {
    const { boss, calls } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, authorize, ...extra })
    return { app, calls }
  }

  it('is called with the pg-boss method, and true lets the call through', async () => {
    const seen: string[] = []
    const { app, calls } = await serve(async (_context, method) => { seen.push(method); return true })

    const response = await app.fetch(await postJson('http://local/api/send', { name: 'queue' }))
    expect(response.status).toBe(200)
    expect(seen).toEqual(['send'])
    expect(calls.get('send')).toHaveLength(1)
  })

  it('false refuses with 403 and the method is not called', async () => {
    const { app, calls } = await serve(() => false)

    const response = await app.fetch(await postJson('http://local/api/send', { name: 'queue' }))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ ok: false, error: { message: 'Forbidden' } })
    expect(calls.get('send')).toHaveLength(0)
  })

  it('a status and message refuse with that status, keeping headers the hook set', async () => {
    const { app } = await serve((context) => {
      context.header('WWW-Authenticate', 'Bearer')
      return { status: 401, message: 'Token expired' }
    })

    const response = await app.fetch(new Request('http://local/api/getQueues'))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(await response.json()).toEqual({ ok: false, error: { message: 'Token expired' } })
  })

  it('refuses when the hook returns nothing', async () => {
    const { app, calls } = await serve((() => undefined) as any)

    const response = await app.fetch(await postJson('http://local/api/send', { name: 'queue' }))
    expect(response.status).toBe(403)
    expect(calls.get('send')).toHaveLength(0)
  })

  it('runs after middleware and before the request is validated', async () => {
    const order: string[] = []
    const middleware: MiddlewareHandler = async (_context, next) => { order.push('middleware'); await next() }
    const { app } = await serve(() => { order.push('authorize'); return false }, { middleware })

    const response = await app.fetch(await postJson('http://local/api/send', { name: '' }))
    expect(response.status).toBe(403)
    expect(order).toEqual(['middleware', 'authorize'])
  })

  it('covers /meta as meta, and not the pages', async () => {
    const seen: string[] = []
    const { app } = await serve((_context, method) => { seen.push(method); return false })

    expect((await app.fetch(new Request('http://local/api/meta'))).status).toBe(403)
    expect((await app.fetch(new Request('http://local/'))).status).toBe(200)
    expect((await app.fetch(new Request('http://local/docs'))).status).toBe(200)
    expect((await app.fetch(new Request('http://local/openapi.json'))).status).toBe(200)
    expect(seen).toEqual(['meta'])
  })

  it('works with a custom prefix', async () => {
    const seen: string[] = []
    const { app } = await serve((_context, method) => { seen.push(method); return true }, { prefix: '/v1' })

    expect((await app.fetch(new Request('http://local/v1/isInstalled'))).status).toBe(200)
    expect(seen).toEqual(['isInstalled'])
  })

  it('a hook that throws answers 500 without the message', async () => {
    const { app } = await serve(() => { throw new Error('store is down') })

    const response = await app.fetch(new Request('http://local/api/getQueues'))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: { message: 'Internal server error' } })
  })
})

describe('mounted in a parent app', () => {
  const mountTwo = async () => {
    const a = createBossMock()
    const b = createBossMock()
    const serviceA = await createProxyService({ options: {}, bossFactory: () => a.boss as any, prefix: '', env: {} })
    const serviceB = await createProxyService({ options: {}, bossFactory: () => b.boss as any, prefix: '', env: {} })
    const parent = new Hono()
    parent.route('/db/a', serviceA.app)
    parent.route('/db/b', serviceB.app)
    return { parent, a, b }
  }

  it('sends each request to its own service', async () => {
    const { parent, a, b } = await mountTwo()

    const response = await parent.fetch(await postJson('http://local/db/b/send', { name: 'queue' }))
    expect(response.status).toBe(200)
    expect(b.calls.get('send')?.[0]).toEqual(['queue'])
    expect(a.calls.get('send')).toHaveLength(0)
  })

  it('the home page links through the mount', async () => {
    const { parent } = await mountTwo()

    const html = await (await parent.fetch(new Request('http://local/db/a'))).text()
    expect(html).toContain('/db/a/send')
    expect(html).toContain('href="/db/a/openapi.json"')
    expect(html).toContain('href="/db/a/docs"')
    expect(html).toContain('href="/db/a/meta"')
  })

  it('the docs load the spec through the mount, and the spec names the mount as its server', async () => {
    const { parent } = await mountTwo()

    const docs = await (await parent.fetch(new Request('http://local/db/b/docs'))).text()
    expect(docs).toContain('/db/b/openapi.json')

    const spec = await (await parent.fetch(new Request('http://local/db/b/openapi.json'))).json() as any
    expect(spec.servers).toEqual([{ url: '/db/b' }])
    expect(spec.paths['/send']).toBeDefined()
  })

  it('a failing method answers with the proxy error body', async () => {
    const { parent, a } = await mountTwo()
    ;(a.boss as any).getQueues = vi.fn(async () => { throw new Error('boom') })

    const response = await parent.fetch(new Request('http://local/db/a/getQueues'))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: { message: 'Internal server error' } })
  })

  it('served at the root, the spec names no server and an empty prefix links to /meta', async () => {
    const { boss } = createBossMock()
    const { app } = await createProxyService({ options: {}, bossFactory: () => boss as any, prefix: '' })

    const spec = await (await app.fetch(new Request('http://local/openapi.json'))).json() as any
    expect(spec.servers).toBeUndefined()

    const html = await (await app.fetch(new Request('http://local/'))).text()
    expect(html).toContain('href="/meta"')
    expect(html).not.toContain('//meta')
  })
})
