import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import type { PgBoss } from '../src/index.ts'
import { ctx } from './hooks.ts'

// A handler that ignores job.signal and returns only when the test releases it.
function heldHandler () {
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  return { release, released }
}

function overrunWarnings (boss: PgBoss) {
  const warnings: any[] = []
  boss.on('warning', warning => {
    if ((warning.data as any)?.type === 'handler_overrun') warnings.push(warning)
  })
  return warnings
}

describe('handler overrun', function () {
  it('should not fetch the retry while the attempt that outran its timeout is still running', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    const jobId = await boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 0, expireInSeconds: 1 })
    assertTruthy(jobId)

    const first = heldHandler()
    const attempts: number[] = []
    let running = 0
    let maxRunning = 0

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
      attempts.push(job.retryCount)
      running++
      maxRunning = Math.max(maxRunning, running)

      try {
        if (job.retryCount === 0) await first.released
      } finally {
        running--
      }
    })

    // Past the 1s timeout and several polling intervals: the retry is ready, but the worker is still
    // held by the first attempt.
    await helper.until(() => attempts.length === 1)
    await delay(2500)

    expect(attempts).toEqual([0])
    expect(warnings.length).toBe(1)
    expect(warnings[0].data).toMatchObject({ queue: ctx.schema, jobs: [jobId], expireInSeconds: 1 })

    // The failed batch is no longer the worker's, so it counts none while it waits.
    expect(boss.getWipData().map(worker => [worker.state, worker.count])).toEqual([['active', 0]])

    const failed = await boss.getJobById(ctx.schema, jobId)
    assertTruthy(failed)
    expect(failed.state).toBe('retry')

    first.release()

    await helper.until(async () => (await boss.getJobById(ctx.schema, jobId))?.state === 'completed')

    expect(attempts).toEqual([0, 1])
    expect(maxRunning).toBe(1)
  })

  // Its batch is already failed, and a stopping worker has nothing to fetch, so there is nothing
  // left to hold the worker for.
  it('offWork() does not wait for a handler that outran its timeout', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    await boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    const held = heldHandler()
    let handlerStarted = false
    let handlerEnded = false

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      handlerStarted = true
      await held.released
      handlerEnded = true
    })

    // Past the 1s timeout, so the batch is already failed when offWork() begins.
    await helper.until(() => handlerStarted)
    await delay(1500)

    expect(warnings.length).toBe(1)

    try {
      await boss.offWork(ctx.schema)

      expect(handlerEnded).toBe(false)
      expect(boss.getWipData()).toEqual([])
    } finally {
      held.release()
    }
  })

  // Group counts are per queue, across work() registrations, so a slot released when offWork()
  // ends the hold would let another registration run the group beside the abandoned handler.
  it('offWork() keeps the localGroupConcurrency slot of a handler that outran its timeout until it returns', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const held = heldHandler()
    const seen: string[] = []
    const holders: string[] = []

    const handler = (workId: () => string) => async ([job]: any[]) => {
      seen.push(job.data.label)
      if (job.data.label === 'a') {
        holders.push(workId())
        await held.released
      }
    }

    const options = { pollingIntervalSeconds: 0.5, localGroupConcurrency: 1 }
    let first = ''
    let second = ''
    first = await boss.work(ctx.schema, options, handler(() => first))
    second = await boss.work(ctx.schema, options, handler(() => second))

    await boss.send(ctx.schema, { label: 'a' }, { group: { id: 'g' }, retryLimit: 0, expireInSeconds: 1 })
    await helper.until(() => holders.length === 1)
    await delay(1500)

    await boss.send(ctx.schema, { label: 'b' }, { group: { id: 'g' } })

    try {
      await boss.offWork(ctx.schema, { id: holders[0] })
      await delay(1500)

      expect(seen).toEqual(['a'])
    } finally {
      held.release()
    }

    await helper.until(() => seen.length === 2)
    expect(seen).toEqual(['a', 'b'])
  })

  it('holds the worker when the timeout fail() throws', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)
    const errors: any[] = []
    boss.on('error', error => errors.push(error))

    const held = heldHandler()
    const seen: string[] = []

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async ([job]: any[]) => {
      seen.push(job.data.label)
      if (job.data.label === 'a') await held.released
    })

    const { default: Manager } = await import('../src/manager.ts')
    const fail = Manager.prototype.fail
    let thrown = false
    Manager.prototype.fail = function (this: any, ...args: any[]) {
      if (!thrown && String(args[2]?.message).includes('handler execution exceeded')) {
        thrown = true
        return Promise.reject(new Error('fail() could not reach the database'))
      }
      return fail.apply(this, args as any)
    } as any

    try {
      await boss.send(ctx.schema, { label: 'a' }, { retryLimit: 0, expireInSeconds: 1 })
      await helper.until(() => seen.length === 1)
      await boss.send(ctx.schema, { label: 'b' })
      await delay(2500)

      expect(thrown).toBe(true)
      expect(warnings.length).toBe(1)
      expect(seen).toEqual(['a'])

      held.release()
      await helper.until(() => seen.length === 2)
      expect(errors.some(error => error.message.startsWith('fail() could not reach the database'))).toBe(true)
    } finally {
      Manager.prototype.fail = fail
      held.release()
    }
  })

  it('a graceful stop does not wait for a handler that outran its timeout', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    await boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    const held = heldHandler()
    let handlerStarted = false
    let handlerEnded = false

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      handlerStarted = true
      await held.released
      handlerEnded = true
    })

    await helper.until(() => handlerStarted)
    await delay(1500)

    expect(warnings.length).toBe(1)

    try {
      const started = Date.now()
      await boss.stop({ timeout: 10000 })

      expect(Date.now() - started).toBeLessThan(5000)
      expect(handlerEnded).toBe(false)
    } finally {
      held.release()
    }
  })
})
