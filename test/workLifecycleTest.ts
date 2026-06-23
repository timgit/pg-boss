import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('work lifecycle', function () {
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
