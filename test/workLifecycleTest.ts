import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { PgBoss, TestClock } from '../src/index.ts'
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
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await ctx.boss.send(ctx.schema)

    let jobStartedResolve!: () => void
    const jobStarted = new Promise<void>(resolve => { jobStartedResolve = resolve })

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 1 }, async ([job]) => {
      jobStartedResolve()
      const wait = delay(10000)
      job.signal.addEventListener('abort', () => wait.abort(), { once: true })
      await wait
    })

    await jobStarted

    let wipCount = 0
    const listener = () => { wipCount++ }
    ctx.boss.on('wip', listener)
    await clock.tick(6000)
    ctx.boss.off('wip', listener)

    expect(wipCount).toBeGreaterThanOrEqual(2)

    // The graceful stop deadline runs on the clock too, so release the handler now rather than
    // leaving teardown to wait on it.
    await ctx.boss.stop({ graceful: false })
  })

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

  it('should allow reads other than fetch() after stopping with close: false', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.stop({ close: false })

    const queues = await ctx.boss.getQueues()
    expect(queues.length).toBeGreaterThan(0)

    const queue = await ctx.boss.getQueue(ctx.schema)
    assertTruthy(queue)
    expect(queue.name).toBe(ctx.schema)
  })

  helper.itPglite('should report the worker error from work() and the database error from send() once the pool closes', async function () {
    // PGlite hands pg-boss a constructor-provided db, so stop() never closes anything and the
    // closed-pool half of this boundary cannot be reached there.
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.stop({ close: false })

    // workers are gone while the pool is open, so work() is refused by the worker check
    await expect(ctx.boss.work(ctx.schema, async () => {})).rejects.toThrow('Workers are disabled')

    await ctx.boss.stop()

    // once the pool is closed the db assert is what everything else hits
    await expect(ctx.boss.send(ctx.schema)).rejects.toThrow('Database not opened')

    // work() still answers for the worker, not the db
    await expect(ctx.boss.work(ctx.schema, async () => {})).rejects.toThrow('Workers are disabled')
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
    let started = 0

    // Send 3 jobs
    for (let i = 0; i < 3; i++) {
      const jobId = await ctx.boss.send(ctx.schema, { index: i }, { retryLimit: 0 })
      jobIds.push(jobId)
    }

    await ctx.boss.work(ctx.schema, { localConcurrency, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      started++
      // All jobs check for abort signal
      for (let i = 0; i < 100; i++) {
        if (job.signal.aborted) {
          abortedJobs.push(job.id)
          return // Return to complete the job
        }
        await delay(100)
      }
    })

    // Wait until all 3 workers have actually picked up a job before stopping. A fixed
    // delay races the last fetch under load: a worker that hasn't fetched when stop()
    // halts fetching never runs its handler, so its signal is never checked (abortedJobs
    // ends at 2 instead of 3). Gate on the real in-flight count instead.
    for (let i = 0; i < 50; i++) {
      if (started >= localConcurrency) break
      await delay(100)
    }
    expect(started).toBe(localConcurrency)

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

describe('work lifecycle shutdown errors', function () {
  it('should report a wip failure and still abort the rest of the workers', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const first = ctx.schema
    const second = `${ctx.schema}_second`
    await ctx.boss.createQueue(second)

    // A db that refuses any statement carrying the first queue's job id once armed, which is the
    // shutdown fail() arriving on a database that will not take it.
    const inner = ctx.boss.getDb()
    let refuseId: string | null = null

    const db = {
      executeSql: (text: string, values?: unknown[]) => {
        if (refuseId && values?.some(value => Array.isArray(value) && value.includes(refuseId))) {
          return Promise.reject(new Error('fail is unavailable'))
        }

        return inner.executeSql(text, values)
      }
    }

    const boss = new PgBoss({ ...ctx.bossConfig, db, createSchema: false, migrate: false })
    const errors: any[] = []
    boss.on('error', err => errors.push(err))

    await boss.start()

    try {
      const firstId = await boss.send(first, null, { retryLimit: 0 })
      const secondId = await boss.send(second, null, { retryLimit: 0 })
      assertTruthy(firstId)
      assertTruthy(secondId)

      const started = new Set<string>()
      const aborted: string[] = []
      const finished: string[] = []

      for (const queue of [first, second]) {
        await boss.work(queue, { pollingIntervalSeconds: 1 }, async ([job]) => {
          started.add(queue)
          await delay(2000)
          if (job.signal.aborted) aborted.push(queue)
          finished.push(queue)
        })
      }

      // Both handlers have to be in flight, so both workers hold a job the shutdown has to fail.
      while (started.size < 2) {
        await delay(100)
      }

      refuseId = firstId
      await boss.stop({ graceful: false, close: false })
      refuseId = null

      while (finished.length < 2) {
        await delay(100)
      }

      expect(errors.some(err => err.queue === first && err.message === 'fail is unavailable')).toBe(true)

      // The second worker was reached even though the first one's fail threw: its job carries the
      // shutdown failure, and both handlers saw the abort.
      const secondJob = await ctx.boss.getJobById(second, secondId)
      assertTruthy(secondJob)
      expect(secondJob.state).toBe('failed')
      // @ts-expect-error untyped object
      expect(secondJob.output?.value).toBe('pg-boss shut down while active')
      expect(aborted.sort()).toEqual([first, second].sort())
    } finally {
      await boss.stop({ graceful: false, close: false })
    }
  })

  it('should finish the shutdown when a wip failure has no error listener', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const first = ctx.schema
    const second = `${ctx.schema}_second`
    await ctx.boss.createQueue(second)

    const inner = ctx.boss.getDb()
    let refuseId: string | null = null

    const db = {
      executeSql: (text: string, values?: unknown[]) => {
        if (refuseId && values?.some(value => Array.isArray(value) && value.includes(refuseId))) {
          return Promise.reject(new Error('fail is unavailable'))
        }

        return inner.executeSql(text, values)
      }
    }

    // No `error` listener anywhere, which is the point: an unhandled `error` event throws
    // ERR_UNHANDLED_ERROR out of emit(), and reporting the wip failure that way would abandon the
    // shutdown at the worker it happened on.
    const boss = new PgBoss({ ...ctx.bossConfig, db, createSchema: false, migrate: false })

    await boss.start()

    try {
      const firstId = await boss.send(first, null, { retryLimit: 0 })
      const secondId = await boss.send(second, null, { retryLimit: 0 })
      assertTruthy(firstId)
      assertTruthy(secondId)

      const started = new Set<string>()
      const finished: string[] = []

      for (const queue of [first, second]) {
        await boss.work(queue, { pollingIntervalSeconds: 1 }, async () => {
          started.add(queue)
          await delay(2000)
          finished.push(queue)
        })
      }

      while (started.size < 2) {
        await delay(100)
      }

      refuseId = firstId
      await boss.stop({ graceful: false, close: false })
      refuseId = null

      while (finished.length < 2) {
        await delay(100)
      }

      // The stop got past the worker whose fail threw, so the second worker's job carries the
      // shutdown failure.
      const secondJob = await ctx.boss.getJobById(second, secondId)
      assertTruthy(secondJob)
      expect(secondJob.state).toBe('failed')
      // @ts-expect-error untyped object
      expect(secondJob.output?.value).toBe('pg-boss shut down while active')
    } finally {
      await boss.stop({ graceful: false, close: false })
    }
  })
})
