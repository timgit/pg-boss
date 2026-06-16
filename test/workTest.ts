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

  it('should fail if burstWhenBacklogExceeds is not a positive integer', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { burstWhenBacklogExceeds: 0 }, async () => {})
    }).rejects.toThrow(/burstWhenBacklogExceeds/)
  })

  it('should fail if burstWhenBatchFull is not a boolean', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss!.work(ctx.schema, { burstWhenBatchFull: 'yes' }, async () => {})
    }).rejects.toThrow(/burstWhenBatchFull/)
  })

  it('fetches continuously when the ready backlog exceeds burstWhenBacklogExceeds', async function () {
    // Backlog is read from the cached queue stats, which are refreshed by the monitor
    // (supervise/monitor intervals) and then copied into memory (queue cache interval).
    // Turn all three down so the worker sees the backlog quickly in this test.
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
    // starts, so its first resolveInterval() already sees a ready backlog over the threshold.
    await delay(3000)

    let processed = 0
    // A 30s base poll means that without the burst bypass at most ~1 job would be processed in
    // the window below. A ready backlog of 10 > 5 should fetch all 10 continuously instead.
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 30, burstWhenBacklogExceeds: 5 }, async () => { processed++ })

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

    // Seed a backlog so the cached ready count is over the threshold.
    const seeded = 5
    for (let i = 0; i < seeded; i++) {
      await ctx.boss.send(ctx.schema)
    }
    await delay(3000) // let the monitor + queue cache reflect the backlog

    let processed = 0
    // batchSize 10 > the 5 seeded jobs, so the first fetch comes back short (5 < 10). Even
    // though the cached backlog (5) exceeds burstWhenBacklogExceeds (1), a short fetch must NOT
    // keep the worker in burst mode — it should fall back to the 3s poll.
    await ctx.boss.work(ctx.schema, { batchSize: 10, pollingIntervalSeconds: 3, burstWhenBacklogExceeds: 1 }, async (jobs) => { processed += jobs.length })

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

  it('should handle a batch of jobs via batchSize', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await ctx.boss.send(ctx.schema)
    }

    return new Promise<void>((resolve) => {
      ctx.boss!.work(ctx.schema, { batchSize }, async jobs => {
        expect(jobs.length).toBe(batchSize)
        resolve()
      })
    })
  })

  it('batchSize should auto-complete the jobs', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, { batchSize: 1 }, async jobs => {
      expect(jobs.length).toBe(1)
    })

    assertTruthy(jobId)
    const job = await spy.waitForJobWithId(jobId, 'completed')

    expect(job.state).toBe('completed')
  })

  it('returning promise applies backpressure', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobCount = 4
    let processCount = 0

    for (let i = 0; i < jobCount; i++) {
      await ctx.boss.send(ctx.schema)
    }

    await ctx.boss.work(ctx.schema, async () => {
      // delay slows down process fetch
      await delay(2000)
      processCount++
    })

    await delay(7000)

    expect(processCount).toBeLessThan(jobCount)
  })

  it('completion should pass string wrapped in value prop', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const result = 'success'

    const jobId = await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, async () => result)

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'completed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('completed')
    expect((job.output as { value: string }).value).toBe(result)
  })

  it('handler result should be stored in output', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema)
    await ctx.boss.work(ctx.schema, async () => ({ something }))

    assertTruthy(jobId)
    const job = await spy.waitForJobWithId(jobId, 'completed')

    expect(job.state).toBe('completed')
    expect((job.output as { something: string }).something).toBe(something)
  })

  it('job can be deleted in handler', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, async ([job]) => ctx.boss!.deleteJob(ctx.schema, job.id))

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'completed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should allow multiple workers to the same ctx.schema per instance', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.work(ctx.schema, async () => {})
    await ctx.boss.work(ctx.schema, async () => {})
  })

  it('should honor the includeMetadata option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    return new Promise<void>((resolve) => {
      ctx.boss!.work(ctx.schema, { includeMetadata: true }, async ([job]) => {
        expect(job.startedOn).toBeDefined()
        resolve()
      })
    })
  })

  it('should fail job at expiration in worker', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await ctx.boss.work(ctx.schema, () => delay(2000))

    await delay(2000)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('failed')
    expect((job.output as any).message).toContain('handler execution exceeded')
  })

  it('should fail a batch of jobs at expiration in worker', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })

    const jobId1 = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })
    const jobId2 = await ctx.boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await ctx.boss.work(ctx.schema, { batchSize: 2 }, () => delay(2000))

    await delay(2000)

    assertTruthy(jobId1)
    assertTruthy(jobId2)
    const job1 = await ctx.boss.getJobById(ctx.schema, jobId1)
    const job2 = await ctx.boss.getJobById(ctx.schema, jobId2)

    assertTruthy(job1)
    expect(job1.state).toBe('failed')
    expect((job1.output as any).message).toContain('handler execution exceeded')

    assertTruthy(job2)
    expect(job2.state).toBe('failed')
    expect((job2.output as any).message).toContain('handler execution exceeded')
  })

  it('should emit wip event every 2s for workers', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const firstWipEvent = new Promise<Array<any>>(resolve => ctx.boss!.once('wip', resolve))

    await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 1 }, () => delay(2000))

    const wip1 = await firstWipEvent

    await ctx.boss.send(ctx.schema)

    expect(wip1.length).toBe(1)

    const secondWipEvent = new Promise<Array<any>>(resolve => ctx.boss!.once('wip', resolve))

    const wip2 = await secondWipEvent

    expect(wip2.length).toBe(1)
  })

  it('should correlate wip entries to work() call via workId', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const firstWipEvent = new Promise<Array<any>>(resolve => ctx.boss!.once('wip', resolve))

    let handlerCompletedResolve: () => void
    const handlerCompleted = new Promise<void>(resolve => { handlerCompletedResolve = resolve })

    await ctx.boss.send(ctx.schema)

    const workId = await ctx.boss.work(ctx.schema, { localConcurrency: 3, pollingIntervalSeconds: 1 }, async () => {
      handlerCompletedResolve()
      await delay(3000)
    })

    const wip = await firstWipEvent

    expect(wip.every((w: any) => w.workId === workId)).toBe(true)
    expect(wip.length).toBe(3)

    await handlerCompleted
  })

  it('getWipData() should return current worker state', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 1 }, () => delay(2000))

    // Wait for the job to be picked up
    const firstWipEvent = new Promise<void>(resolve => ctx.boss!.once('wip', () => resolve()))
    await firstWipEvent

    const wip = ctx.boss.getWipData()

    expect(wip.length).toBe(1)
    expect(wip[0].name).toBe(ctx.schema)
    expect(wip[0].state).toBe('active')
  })

  it('should emit wip heartbeat while workers are busy with long-running jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    let jobStartedResolve!: () => void
    const jobStarted = new Promise<void>(resolve => { jobStartedResolve = resolve })

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 1 }, async ([job]) => {
      jobStartedResolve()
      const ac = new AbortController()
      job.signal.addEventListener('abort', () => ac.abort(), { once: true })
      try {
        await delay(10000, undefined, ac)
      } catch {
        // aborted during boss.stop() teardown — expected
      }
    })

    await jobStarted

    let wipCount = 0
    const listener = () => { wipCount++ }
    ctx.boss.on('wip', listener)
    await delay(6000)
    ctx.boss.off('wip', listener)

    expect(wipCount).toBeGreaterThanOrEqual(2)
  }, 20000)

  it('should reject work() after stopping', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.stop()

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, async () => {})
    }).rejects.toThrow()
  })

  it('should allow send() after stopping', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    ctx.boss.stop({ close: false })

    await ctx.boss.send(ctx.schema)
  })

  it('should abort signal when graceful shutdown timeout expires', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let signalAborted = false

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })

    assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, async ([job]) => {
      await new Promise<void>(resolve => {
        job.signal.addEventListener('abort', () => {
          signalAborted = true
          resolve()
        }, { once: true })
      })
    })

    await delay(500)

    // Stop with 1 second timeout - handler waits for abort event
    await ctx.boss.stop({ timeout: 1000 })

    await ctx.boss.start()

    const [job] = await ctx.boss.findJobs(ctx.schema, { id: jobId })

    assertTruthy(job)

    expect(signalAborted).toBe(true)
    expect(job.state).toBe('failed')
    expect(job.output).toBeTruthy()
  })

  it('should complete job successfully when finished within graceful shutdown period', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let signalAborted = false

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })

    await ctx.boss.work(ctx.schema, async ([job]) => {
      // Job takes 500ms to complete
      await delay(500)
      signalAborted = job.signal.aborted
    })

    await delay(100)

    // Stop with 5 second timeout - job completes in 500ms, will complete during grace period
    await ctx.boss.stop({ timeout: 5000 })

    await ctx.boss.start()

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect(signalAborted).toBe(false)
    expect(job.state).toBe('completed')
  })

  it('should abort signal immediately when graceful is false', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let signalAborted = false
    let handlerStarted = false

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })

    await ctx.boss.work(ctx.schema, async ([job]) => {
      handlerStarted = true
      // Job takes 2 seconds to complete
      await delay(2000)
      signalAborted = job.signal.aborted
    })

    await delay(500)
    expect(handlerStarted).toBe(true)

    // Non-graceful shutdown - should fail job immediately, no grace period
    await ctx.boss.stop({ graceful: false, close: false })

    // Give handler time to complete
    await delay(2000)

    await ctx.boss.start()

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById<{}>(ctx.schema, jobId)

    assertTruthy(job)
    expect(job.state).toBe('failed')
    // @ts-expect-error untyped object
    expect((job.output)?.value).toBe('pg-boss shut down while active')
    // Signal should be aborted immediately in non-graceful shutdown
    expect(signalAborted).toBe(true)
  })

  it('should fire abort signal with multiple workers (localConcurrency)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const localConcurrency = 3
    const abortedJobs: string[] = []
    const jobIds: (string | null)[] = []

    // Send 3 jobs
    for (let i = 0; i < 3; i++) {
      const jobId = await ctx.boss.send(ctx.schema, { index: i }, { retryLimit: 0 })
      jobIds.push(jobId)
    }

    await ctx.boss.work(ctx.schema, { localConcurrency, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      // All jobs check for abort signal
      for (let i = 0; i < 100; i++) {
        if (job.signal.aborted) {
          abortedJobs.push(job.id)
          return // Return to complete the job
        }
        await delay(100)
      }
    })

    // Wait for all workers to start
    await delay(500)

    // Stop with short timeout - jobs take 10s, so timeout will expire
    await ctx.boss.stop({ timeout: 1000 })

    // Wait for handlers to detect abort
    await delay(500)

    // All 3 jobs should have detected the abort signal
    // This verifies abort signal works with multiple workers (localConcurrency)
    expect(abortedJobs.length).toBe(3)

    await ctx.boss.start()

    // All 3 jobs should be marked as failed
    for (let i = 0; i < 3; i++) {
      const jobId = jobIds[i]
      assertTruthy(jobId)
      // @ts-ignore
      const job = await ctx.boss.getJobById(ctx.schema, jobId)
      assertTruthy(job)
      expect(job.state).toBe('failed')
      expect(job.output).toBeTruthy()
    }
  })
})
