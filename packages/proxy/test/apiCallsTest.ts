import { describe, expect, it, vi } from 'vitest'
import { createProxyApp } from '../src/index.js'

const bossMethods = [
  'send',
  'sendAfter',
  'sendThrottled',
  'sendDebounced',
  'insert',
  'fetch',
  'subscribe',
  'unsubscribe',
  'publish',
  'cancel',
  'resume',
  'retry',
  'deleteJob',
  'deleteQueuedJobs',
  'deleteStoredJobs',
  'deleteAllJobs',
  'complete',
  'fail',
  'findJobs',
  'createQueue',
  'getBlockedKeys',
  'updateQueue',
  'deleteQueue',
  'getQueues',
  'getQueue',
  'getQueueStats',
  'supervise',
  'isInstalled',
  'schemaVersion',
  'schedule',
  'unschedule',
  'getSchedules',
  'getBamStatus',
] as const

type BossMethod = (typeof bossMethods)[number]

const createBossMock = () => {
  const boss = {} as Record<string, unknown>
  const calls = new Map<BossMethod, unknown[][]>()

  for (const method of bossMethods) {
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
  it('calls the expected pg-boss methods with args', async () => {
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
        body: { name: 'queue', id: '1', options: {} },
        expected: ['queue', '1', {}]
      },
      {
        method: 'resume',
        body: { name: 'queue', id: '1', options: {} },
        expected: ['queue', '1', {}]
      },
      {
        method: 'retry',
        body: { name: 'queue', id: '1', options: {} },
        expected: ['queue', '1', {}]
      },
      {
        method: 'deleteJob',
        body: { name: 'queue', id: '1', options: {} },
        expected: ['queue', '1', {}]
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
        body: { name: 'queue', id: ['1', '2'], options: { db: {} } },
        expected: ['queue', ['1', '2'], null, { db: {} }]
      },
      {
        method: 'findJobs',
        body: { name: 'queue', options: { id: '1' } },
        expected: ['queue', { id: '1' }]
      },
      {
        method: 'createQueue',
        body: { name: 'queue', options: { retryLimit: 1 } },
        expected: ['queue', { retryLimit: 1 }]
      },
      {
        method: 'getBlockedKeys',
        body: { name: 'queue' },
        expected: ['queue']
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
        method: 'getQueues',
        body: { names: ['a', 'b'] },
        expected: [['a', 'b']]
      },
      {
        method: 'getQueue',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'getQueueStats',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'supervise',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'isInstalled',
        expected: []
      },
      {
        method: 'schemaVersion',
        expected: []
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
      {
        method: 'getSchedules',
        body: { name: 'queue' },
        expected: ['queue']
      },
      {
        method: 'getBamStatus',
        expected: []
      },
    ]

    for (const entry of cases) {
      const request = await postJson(`http://local/api/${entry.method}`, entry.body)
      const response = await app.fetch(request)
      expect(response.status).toBe(200)

      const methodCalls = calls.get(entry.method)
      expect(methodCalls?.length).toBe(1)
      expect(methodCalls?.[0]).toEqual(entry.expected)
    }
  })
})
