import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import * as Attorney from '../src/attorney.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('work', function () {
  it('should fail with no arguments', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.work()
    }).rejects.toThrow()
  })

  it('should fail if no callback provided', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.work('foo')
    }).rejects.toThrow()
  })

  it('should fail if options is not an object', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.work('foo', async () => {}, 'nope')
    }).rejects.toThrow()
  })

  it('should fail if notifyPollingIntervalSeconds is below the minimum', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { notifyPollingIntervalSeconds: 0.1 }, async () => {})
    }).rejects.toThrow(/notifyPollingIntervalSeconds must be at least/)
  })

  it('should fail if notifyPollingIntervalSeconds is smaller than pollingIntervalSeconds', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { pollingIntervalSeconds: 10, notifyPollingIntervalSeconds: 5 }, async () => {})
    }).rejects.toThrow(/notifyPollingIntervalSeconds must be at least pollingIntervalSeconds/)
  })

  it('allows notifyPollingIntervalSeconds equal to pollingIntervalSeconds', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    // Equal is fine; only strictly-smaller is a misconfiguration.
    const id = await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 10, notifyPollingIntervalSeconds: 10 }, async () => {})
    expect(id).toBeTruthy()
  })

  it('floors the default notify interval at the base poll when base exceeds 30s', function () {
    // No notifyPollingIntervalSeconds set: the default must not fall below a larger base poll.
    const { options } = Attorney.checkWorkArgs(ctx.schema, [{ pollingIntervalSeconds: 40 }, async () => {}])
    expect(options.pollingInterval).toBe(40000)
    expect(options.notifyPollingInterval).toBe(40000) // max(30000, 40000)
  })

  it('defaults the notify interval to 30s when the base poll is below it', function () {
    const { options } = Attorney.checkWorkArgs(ctx.schema, [{ pollingIntervalSeconds: 5 }, async () => {}])
    expect(options.notifyPollingInterval).toBe(30000)
  })

  it('should fail if burstWhenReadyExceeds is not a positive integer', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { burstWhenReadyExceeds: 0 }, async () => {})
    }).rejects.toThrow(/burstWhenReadyExceeds/)
  })

  it('should fail if burstWhenBatchFull is not a boolean', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss!.work(ctx.schema, { burstWhenBatchFull: 'yes' }, async () => {})
    }).rejects.toThrow(/burstWhenBatchFull/)
  })

  it('fetches continuously when the ready count exceeds burstWhenReadyExceeds', async function () {
    // The ready count is read from the cached queue stats, which are refreshed by the monitor
    // (supervise/monitor intervals) and then copied into memory (queue cache interval).
    // Turn all three down so the worker sees the ready count quickly in this test.
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      supervise: true,
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
      queueCacheIntervalSeconds: 1
    })

    const jobCount = 10
    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    // Let the monitor compute the stats and the queue cache pick them up before the worker
    // starts, so its first resolveInterval() already sees a ready count over the threshold.
    await delay(3000)

    let processed = 0
    // A 30s base poll means that without the burst bypass at most ~1 job would be processed in
    // the window below. A ready count of 10 > 5 should fetch all 10 continuously instead.
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 30, burstWhenReadyExceeds: 5 }, async () => { processed++ })

    for (let i = 0; i < 30; i++) {
      if (processed >= jobCount) break
      await delay(100)
    }

    expect(processed).toBe(jobCount)
  })

  it('fetches continuously while fetches return a full batch with burstWhenBatchFull', async function () {
    // No cached-stats dependency: burstWhenBatchFull is driven purely by the fetch result.
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobCount = 12
    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    let processed = 0
    // batchSize 5 -> fetches of 5, 5, then 2 (short). The full batches keep the worker fetching
    // with no delay; the short fetch ends it. Without the bypass the 30s base poll would let at
    // most one batch through in the window below.
    await ctx.boss.work(ctx.schema, { batchSize: 5, pollingIntervalSeconds: 30, burstWhenBatchFull: true }, async (jobs) => { processed += jobs.length })

    for (let i = 0; i < 30; i++) {
      if (processed >= jobCount) break
      await delay(100)
    }

    expect(processed).toBe(jobCount)
  })

  it('ignores burstWhenBatchFull when batchSize is 1', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let processed = 0
    // batchSize defaults to 1, so burstWhenBatchFull is a no-op: after the first job the worker
    // must wait out the 30s base poll rather than fetching continuously.
    await ctx.boss.send(ctx.schema)
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 30, burstWhenBatchFull: true }, async (jobs) => { processed += jobs.length })

    await delay(500)
    expect(processed).toBe(1)

    // A second job sent now is not picked up early — it waits on the 30s poll.
    await ctx.boss.send(ctx.schema)
    await delay(1200)
    expect(processed).toBe(1)
  })

  it('resumes normal polling when a fetch returns fewer jobs than the batch size', async function () {
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      supervise: true,
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
      queueCacheIntervalSeconds: 1
    })

    // Seed jobs so the cached ready count is over the threshold.
    const seeded = 5
    for (let i = 0; i < seeded; i++) {
      await ctx.boss.send(ctx.schema)
    }
    await delay(3000) // let the monitor + queue cache reflect the ready count

    let processed = 0
    // batchSize 10 > the 5 seeded jobs, so the first fetch comes back short (5 < 10). Even
    // though the cached ready count (5) exceeds burstWhenReadyExceeds (1), a short fetch must NOT
    // keep the worker in burst mode — it should fall back to the 3s poll.
    await ctx.boss.work(ctx.schema, { batchSize: 10, pollingIntervalSeconds: 3, burstWhenReadyExceeds: 1 }, async (jobs) => { processed += jobs.length })

    // The first fetch grabs all seeded jobs in one batch.
    await delay(500)
    expect(processed).toBe(seeded)

    // A new job sent now must wait out the 3s fallback poll. If the short-batch gate were
    // missing, the stale cache would keep the worker hot-looping at 0 and grab it immediately.
    await ctx.boss.send(ctx.schema)
    await delay(1200)
    expect(processed).toBe(seeded)
  })

  it('offWork should fail without a name', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.offWork()
    }).rejects.toThrow()
  })

  it('should honor a custom polling interval', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const pollingIntervalSeconds = 1
    const timeout = 5000
    let processCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {
      processCount++
    })

    await delay(timeout)

    expect(processCount).toBe(timeout / 1000 / pollingIntervalSeconds)
  })

  it('should provide abort signal to job handler', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    let receivedSignal = {}

    const jobId = await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, async ([job]) => {
      receivedSignal = job.signal
    })

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'completed')

    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })

  it('should honor when a worker is notified', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    let processCount = 0

    const jobId1 = await ctx.boss.send(ctx.schema)

    const workerId = await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 5 }, async () => processCount++)

    assertTruthy(jobId1)
    await spy.waitForJobWithId(jobId1, 'completed')

    expect(processCount).toBe(1)

    const jobId2 = await ctx.boss.send(ctx.schema)

    ctx.boss.notifyWorker(workerId)

    assertTruthy(jobId2)
    await spy.waitForJobWithId(jobId2, 'completed')

    expect(processCount).toBe(2)
  })

  it('should remove a worker', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let receivedCount = 0

    ctx.boss.work(ctx.schema, async () => {
      receivedCount++
      await ctx.boss!.offWork(ctx.schema)
    })

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    await delay(5000)

    expect(receivedCount).toBe(1)
  })

  it('should remove a worker by id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let receivedCount = 0

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    const id = await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      receivedCount++
      await ctx.boss!.offWork(ctx.schema, { id })
    })

    await delay(2000)

    expect(receivedCount).toBe(1)
  })
})
