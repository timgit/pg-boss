import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

// A poll interval no test waits out, so a drain that finishes shows it skipped the delay.
const pollingIntervalSeconds = 30

describe('drain', function () {
  it('should resolve at once when no workers are registered', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 0, failed: 0, timedOut: false })
  })

  it('should process every ready job across queues and then resolve', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const other = ctx.schema + '_other'
    await ctx.boss.createQueue(other)

    const ids = await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(other),
      ctx.boss.send(other)
    ])

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {})
    await ctx.boss.work(other, { pollingIntervalSeconds }, async () => {})

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 5, failed: 0, timedOut: false })

    for (const [i, id] of ids.entries()) {
      assertTruthy(id)
      const job = await ctx.boss.getJobById(i < 3 ? ctx.schema : other, id)
      expect(job?.state).toBe('completed')
    }
  })

  it('should process jobs a handler sends to another worker\'s queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const next = ctx.schema + '_next'
    await ctx.boss.createQueue(next)

    let nextHandled = 0

    await ctx.boss.work(next, { pollingIntervalSeconds }, async () => { nextHandled++ })
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {
      await ctx.boss!.send(next)
    })

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 4, failed: 0, timedOut: false })
    expect(nextHandled).toBe(2)
  })

  it('should count failed jobs without throwing', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, { fail: false })
    const failedId = await ctx.boss.send(ctx.schema, { fail: true }, { retryLimit: 0 })
    assertTruthy(failedId)

    await ctx.boss.work<{ fail: boolean }>(ctx.schema, { pollingIntervalSeconds }, async ([job]) => {
      if (job.data.fail) throw new Error('nope')
    })

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 2, failed: 1, timedOut: false })

    const job = await ctx.boss.getJobById(ctx.schema, failedId)
    expect(job?.state).toBe('failed')
  })

  it('should run retries that are ready at once', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { retryLimit: 2, retryDelay: 0 })

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => { throw new Error('nope') })

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 3, failed: 3, timedOut: false })
  })

  it('should not wait for a retry that is waiting out its backoff', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 60 })
    assertTruthy(id)

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => { throw new Error('nope') })

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 1, failed: 1, timedOut: false })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    expect(job?.state).toBe('retry')
  })

  it('should not wait for a job deferred with startAfter', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema, null, { startAfter: 60 })

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {})

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 1, failed: 0, timedOut: false })
  })

  it('should count each job of a batch', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.insert(ctx.schema, Array.from({ length: 12 }, () => ({})))

    const batches: number[] = []

    await ctx.boss.work(ctx.schema, { batchSize: 5, pollingIntervalSeconds }, async jobs => { batches.push(jobs.length) })

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 12, failed: 0, timedOut: false })
    expect(batches.sort()).toEqual([2, 5, 5])
  })

  it('should count a failed batch as one failure per job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.insert(ctx.schema, Array.from({ length: 3 }, () => ({ retryLimit: 0 })))

    await ctx.boss.work(ctx.schema, { batchSize: 3, pollingIntervalSeconds }, async () => { throw new Error('nope') })

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 3, failed: 3, timedOut: false })
  })

  it('should count per-job failures from a perJobResults handler', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.insert(ctx.schema, Array.from({ length: 4 }, (_, i) => ({ data: { i }, retryLimit: 0 })))

    await ctx.boss.work<{ i: number }>(ctx.schema, { batchSize: 4, perJobResults: true, pollingIntervalSeconds }, async jobs =>
      jobs.map(job => job.data.i % 2
        ? { id: job.id, status: 'failed' as const, output: { reason: 'odd' } }
        : { id: job.id, status: 'completed' as const }))

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 4, failed: 2, timedOut: false })
  })

  it('should come back for group jobs held back by localGroupConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.insert(ctx.schema, Array.from({ length: 4 }, () => ({ group: { id: 'tenant' } })))

    await ctx.boss.work(ctx.schema, { localConcurrency: 2, localGroupConcurrency: 1, pollingIntervalSeconds }, async () => { await delay(50) })

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 4, failed: 0, timedOut: false })
  })

  it('should stop at the timeout and wait for the batch in flight', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const handlerStarted = new Promise<void>(resolve => { started = resolve })
    let calls = 0

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {
      calls++
      started()
      await gate
    })

    let settled = false
    const draining = ctx.boss.drain({ timeoutSeconds: 1 }).finally(() => { settled = true })

    await handlerStarted
    await delay(1500)

    expect(settled).toBe(false)

    release()

    const result = await draining

    expect(result).toEqual({ processed: 1, failed: 0, timedOut: true })
    expect(calls).toBe(1)
  })

  it('should resolve overlapping calls at the same idle point', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => { await delay(100) })

    const [first, second] = await Promise.all([ctx.boss.drain(), ctx.boss.drain()])

    expect(first).toEqual({ processed: 2, failed: 0, timedOut: false })
    expect(second).toEqual(first)
  })

  it('should resolve when its workers are stopped', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    let started!: () => void
    const handlerStarted = new Promise<void>(resolve => { started = resolve })

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {
      started()
      await delay(200)
    })

    const draining = ctx.boss.drain()

    await handlerStarted
    await ctx.boss.offWork(ctx.schema)

    const result = await draining

    expect(result).toEqual({ processed: 1, failed: 0, timedOut: false })
  })

  it('should leave workers polling afterwards', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let handled = 0

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 1 }, async () => { handled++ })

    await ctx.boss.drain()
    await ctx.boss.send(ctx.schema)
    await delay(2500)

    expect(handled).toBe(1)
  })

  it('should reject an invalid timeoutSeconds', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(ctx.boss.drain({ timeoutSeconds: 0 })).rejects.toThrow('timeoutSeconds must be a number > 0')
    await expect(ctx.boss.drain({ timeoutSeconds: '5' as any })).rejects.toThrow('timeoutSeconds must be a number > 0')
  })
})
