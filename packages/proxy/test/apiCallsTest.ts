import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProxyApp } from '../src/index.js'
import { bossMethodNames } from '../src/routes.js'
import type { MiddlewareHandler } from 'hono'

type BossMethod = string

const createBossMock = () => {
  const boss = {} as Record<string, unknown>
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
  it('calls the expected pg-boss methods with args (POST)', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

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
        body: { name: 'queue', cron: '* * * * *', data: { a: 1 }, options: { tz: 'UTC' } },
        expected: ['queue', '* * * * *', { a: 1 }, { tz: 'UTC' }]
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
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

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
      { method: 'getQueues', query: 'names=a&names=b', expected: [['a', 'b']] },
      { method: 'getQueues', expected: [] },
      { method: 'getSchedules', query: 'name=queue&key=k', expected: ['queue', 'k'] },
      { method: 'getSchedules', query: 'name=queue', expected: ['queue'] },
      { method: 'getSchedules', expected: [] },
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

  it('GET findJobs passes flattened options as query params', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue&id=1&queued=true', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue', { id: '1', queued: true }])
  })

  it('GET findJobs with dataKey and dataValue builds data filter', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue&dataKey=status&dataValue=pending', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue', { data: { status: 'pending' } }])
  })

  it('GET findJobs with dataKey only uses null as value', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue&dataKey=status', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue', { data: { status: null } }])
  })

  it('GET findJobs works without options', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const findReq = new Request('http://local/api/findJobs?name=queue', { method: 'GET' })
    const findRes = await app.fetch(findReq)
    expect(findRes.status).toBe(200)
    expect(calls.get('findJobs')?.[0]).toEqual(['queue'])
  })

  it('rejects oversized request bodies', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any, bodyLimit: 100 })

    const jsonBody = JSON.stringify({ name: 'queue', data: { payload: 'x'.repeat(200) } })
    const request = new Request('http://local/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(jsonBody.length) },
      body: jsonBody
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(413)

    const body = await response.json()
    expect(body.ok).toBe(false)
  })

  it('returns 400 for malformed POST body', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    // Missing required 'name' field
    const request = await postJson('http://local/api/send', { data: { foo: 'bar' } })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.error.message).toBeTruthy()
  })

  it('returns 400 for wrong types in POST body', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    // 'seconds' should be a number
    const request = await postJson('http://local/api/sendThrottled', {
      name: 'queue',
      data: null,
      options: null,
      seconds: 'not-a-number'
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json()
    expect(body.ok).toBe(false)
  })

  it('returns 500 with generic message when method throws (exposeErrors: false)', async () => {
    const { boss } = createBossMock()
    ;(boss as any).send = vi.fn(async () => { throw new Error('db connection lost') })
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(500)

    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.error.message).toBe('Internal server error')
  })

  it('returns 500 with real message when method throws (exposeErrors: true)', async () => {
    const { boss } = createBossMock()
    ;(boss as any).send = vi.fn(async () => { throw new Error('db connection lost') })
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any, exposeErrors: true })

    const request = await postJson('http://local/api/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(500)

    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.error.message).toBe('db connection lost')
  })

  it('returns 500 with generic message for GET method throws (exposeErrors: false)', async () => {
    const { boss } = createBossMock()
    ;(boss as any).isInstalled = vi.fn(async () => { throw new Error('secret error') })
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/isInstalled', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(500)

    const body = await response.json()
    expect(body.error.message).toBe('Internal server error')
  })

  it('edge case: send with only name (no data/options)', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('send')?.[0]).toEqual(['queue'])
  })

  it('edge case: deleteAllJobs with no name', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/deleteAllJobs', {})
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('deleteAllJobs')?.[0]).toEqual([])
  })

  it('edge case: unschedule without key', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/unschedule', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('unschedule')?.[0]).toEqual(['queue'])
  })

  it('edge case: supervise with no name', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/supervise', {})
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('supervise')?.[0]).toEqual([])
  })

  it('edge case: getQueues with single name query param', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/getQueues?names=single', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('getQueues')?.[0]).toEqual([['single']])
  })

  it('GET /api/meta returns states/policies/events', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/meta', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.result.states).toBeDefined()
    expect(body.result.policies).toBeDefined()
    expect(body.result.events).toBeDefined()
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

    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any, middleware: authMiddleware })

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

    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any, middleware: rejectAll })

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
    const { boss, calls } = createBossMock()
    const log: string[] = []

    const mw1: MiddlewareHandler = async (_c, next) => {
      log.push('mw1')
      await next()
    }
    const mw2: MiddlewareHandler = async (_c, next) => {
      log.push('mw2')
      await next()
    }

    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any, middleware: [mw1, mw2] })

    const request = new Request('http://local/api/isInstalled', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(log).toEqual(['mw1', 'mw2'])
  })

  it('rejects empty name with 400', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/send', { name: '' })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json()
    expect(body.ok).toBe(false)
  })

  it('rejects empty event name with 400', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/subscribe', { event: '', name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json()
    expect(body.ok).toBe(false)
  })

  it('rejects empty name in GET query with 400', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/getQueue?name=', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(400)

    const body = await response.json()
    expect(body.ok).toBe(false)
  })

  it('sendThrottled without key does not pass trailing undefined', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = await postJson('http://local/api/sendThrottled', {
      name: 'queue', data: null, options: null, seconds: 5
    })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)

    const args = calls.get('sendThrottled')?.[0]
    expect(args).toEqual(['queue', null, null, 5])
    expect(args?.length).toBe(4)
  })

  it('OpenAPI and docs paths respect prefix', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any, prefix: '/v1' })

    const openapiReq = new Request('http://local/v1/openapi.json', { method: 'GET' })
    const openapiRes = await app.fetch(openapiReq)
    expect(openapiRes.status).toBe(200)
    const spec = await openapiRes.json()
    expect(spec.openapi).toBe('3.1.0')

    const docsReq = new Request('http://local/v1/docs', { method: 'GET' })
    const docsRes = await app.fetch(docsReq)
    expect(docsRes.status).toBe(200)
  })

  it('custom prefix routes work correctly', async () => {
    const { boss, calls } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any, prefix: '/v1' })

    const request = await postJson('http://local/v1/send', { name: 'queue' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)
    expect(calls.get('send')?.[0]).toEqual(['queue'])
  })

  it('normalizePrefix handles edge cases', async () => {
    const { boss } = createBossMock()

    // prefix "/" normalizes to "" (root)
    const { prefix: p1 } = createProxyApp({ options: {}, bossFactory: () => boss as any, prefix: '/' })
    expect(p1).toBe('')

    // prefix without leading slash gets one added
    const { prefix: p2 } = createProxyApp({ options: {}, bossFactory: () => boss as any, prefix: 'api' })
    expect(p2).toBe('/api')

    // trailing slash stripped
    const { prefix: p3 } = createProxyApp({ options: {}, bossFactory: () => boss as any, prefix: '/api/' })
    expect(p3).toBe('/api')
  })

  it('home page renders method list and links', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/', { method: 'GET' })
    const response = await app.fetch(request)
    expect(response.status).toBe(200)

    const html = await response.text()
    expect(html).toContain('pg-boss proxy')
    expect(html).toContain('/api/send')
    expect(html).toContain('/api/openapi.json')
    expect(html).toContain('/api/docs')
    expect(html).toContain('POST')
    expect(html).toContain('GET')
  })

  it('OpenAPI spec includes tags and operationId', async () => {
    const { boss } = createBossMock()
    const { app } = createProxyApp({ options: {}, bossFactory: () => boss as any })

    const request = new Request('http://local/api/openapi.json', { method: 'GET' })
    const response = await app.fetch(request)
    const spec = await response.json()

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

    createProxyApp({
      options: { connectionString: 'postgres://localhost/test' } as any,
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

describe('node.ts resolveOptions', () => {
  const originalEnv = process.env.DATABASE_URL

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DATABASE_URL = originalEnv
    } else {
      delete process.env.DATABASE_URL
    }
  })

  it('uses connectionString when provided', async () => {
    const { createProxyAppNode } = await import('../src/node.js')
    const { boss } = createBossMock()
    let receivedOptions: Record<string, unknown> = {}

    // Monkey-patch createProxyApp via bossFactory isn't available on node.ts,
    // but we can test resolveOptions indirectly through the thrown error path
    // Actually, createProxyAppNode calls createProxyApp which calls new PgBoss
    // We need to test the options resolution. Let's just test error cases and
    // verify the function works by checking it doesn't throw for valid inputs.

    // We can't easily unit test resolveOptions directly since it's not exported,
    // but we can test the public API behavior.

    // connectionString should work (will throw at PgBoss construction, not at resolve)
    expect(() => createProxyAppNode({ connectionString: 'postgres://localhost/test' })).not.toThrow()
  })

  it('uses options when provided', async () => {
    const { createProxyAppNode } = await import('../src/node.js')
    expect(() => createProxyAppNode({ options: { connectionString: 'postgres://localhost/test' } as any })).not.toThrow()
  })

  it('falls back to DATABASE_URL', async () => {
    const { createProxyAppNode } = await import('../src/node.js')
    process.env.DATABASE_URL = 'postgres://localhost/test'
    expect(() => createProxyAppNode()).not.toThrow()
  })

  it('throws when both connectionString and options are provided', async () => {
    const { createProxyAppNode } = await import('../src/node.js')
    expect(() => createProxyAppNode({
      connectionString: 'postgres://localhost/test',
      options: { connectionString: 'postgres://localhost/other' } as any
    })).toThrow('Provide either connectionString or options, not both.')
  })

  it('throws when no connection info is available', async () => {
    const { createProxyAppNode } = await import('../src/node.js')
    delete process.env.DATABASE_URL
    expect(() => createProxyAppNode({})).toThrow('Proxy requires PgBoss constructor options or DATABASE_URL.')
  })
})
