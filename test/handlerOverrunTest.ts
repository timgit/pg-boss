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

async function storedOverruns (schema: string) {
  const db = await helper.getDb()

  try {
    const { rows } = await db.executeSql(
      `SELECT message, data FROM ${schema}.warning WHERE type = 'handler_overrun' ORDER BY created_on, data->>'until'`)
    return rows.map(row => row.data)
  } finally {
    await db.close()
  }
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

  // offWork() on the last registration drops the queue's group config, but the abandoned handler's
  // count has to outlive it, or work() again runs the group beside it and its late release frees
  // another handler's slot.
  it('work() after offWork() keeps the localGroupConcurrency slot of a handler that outran its timeout', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss

    const holds: Record<string, ReturnType<typeof heldHandler>> = { a: heldHandler(), b: heldHandler(), c: heldHandler() }
    const running = new Set<string>()

    const handler = async ([job]: any[]) => {
      running.add(job.data.label)
      try {
        await holds[job.data.label].released
      } finally {
        running.delete(job.data.label)
      }
    }

    const options = { pollingIntervalSeconds: 0.5, localGroupConcurrency: 1, localConcurrency: 2 }
    await boss.work(ctx.schema, options, handler)

    await boss.send(ctx.schema, { label: 'a' }, { group: { id: 'g' }, retryLimit: 0, expireInSeconds: 1 })
    await helper.until(() => running.has('a'))
    await delay(1500)

    try {
      await boss.offWork(ctx.schema)
      await boss.work(ctx.schema, options, handler)

      await boss.send(ctx.schema, { label: 'b' }, { group: { id: 'g' } })
      await delay(1500)
      expect([...running]).toEqual(['a'])

      holds.a.release()
      await helper.until(() => running.has('b'))

      await boss.send(ctx.schema, { label: 'c' }, { group: { id: 'g' } })
      await delay(1500)
      expect([...running]).toEqual(['b'])
    } finally {
      Object.values(holds).forEach(hold => hold.release())
    }
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

  // One row for the first overrun, then a count, rather than a row per batch.
  it('writes the first overrun to the warning table and counts the rest until stop()', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistWarnings: true })
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    const jobIds = [
      await boss.send(ctx.schema, { n: 1 }, { retryLimit: 0, expireInSeconds: 1 }),
      await boss.send(ctx.schema, { n: 2 }, { retryLimit: 0, expireInSeconds: 1 }),
      await boss.send(ctx.schema, { n: 3 }, { retryLimit: 0, expireInSeconds: 1 })
    ]

    // Ignores its signal and returns a little after its timeout.
    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => { await delay(1200) })

    await helper.until(() => warnings.length === 3, 15000)

    const [instance] = await boss.getInstances()
    expect(warnings.map(w => w.data.instance)).toEqual([instance.id, instance.id, instance.id])

    const beforeStop = await storedOverruns(ctx.schema)
    expect(beforeStop).toHaveLength(1)
    expect(beforeStop[0]).toMatchObject({ instance: instance.id, queue: ctx.schema, count: 1, jobs: [warnings[0].data.jobs[0]], expireInSeconds: 1 })
    expect(beforeStop[0].since).toBe(beforeStop[0].until)

    await boss.stop({ graceful: false })

    const rows = await storedOverruns(ctx.schema)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ instance: instance.id, queue: ctx.schema, count: 2, since: rows[0].since, expireInSeconds: 1 })
    expect(rows[1].jobs).toEqual(warnings.slice(1).map(w => w.data.jobs[0]))
    expect(new Set(warnings.map(w => w.data.jobs[0]))).toEqual(new Set(jobIds))
  })

  it('writes a window\'s count when the window ends', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistWarnings: true, __test__handlerOverrunWindowMs: 2500 })
    const boss = ctx.boss

    for (let n = 0; n < 4; n++) {
      await boss.send(ctx.schema, { n }, { retryLimit: 0, expireInSeconds: 1 })
    }

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => { await delay(1200) })

    // The first row is written at once and the second by the window's timer, before any stop().
    await helper.until(async () => (await storedOverruns(ctx.schema)).length >= 2, 15000)

    const rows = await storedOverruns(ctx.schema)
    expect(rows[0].count).toBe(1)
    expect(rows[1].count).toBeGreaterThanOrEqual(1)
    expect(rows[1].since).toBe(rows[0].since)
    expect(rows[1].until > rows[1].since).toBe(true)
  })

  // A window that counted nothing closes its tally, so the next overrun is not held back.
  it('writes an overrun at once again after a window with none', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistWarnings: true, __test__handlerOverrunWindowMs: 300 })
    const boss = ctx.boss

    await boss.send(ctx.schema, { n: 1 }, { retryLimit: 0, expireInSeconds: 1 })

    const held = heldHandler()
    let calls = 0

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      if (++calls === 1) await held.released
      else await delay(1200)
    })

    await helper.until(async () => (await storedOverruns(ctx.schema)).length === 1, 10000)

    // Several windows pass with the worker held and nothing counted.
    await delay(1000)
    held.release()

    await boss.send(ctx.schema, { n: 2 }, { retryLimit: 0, expireInSeconds: 1 })

    await helper.until(async () => (await storedOverruns(ctx.schema)).length === 2, 10000)

    const rows = await storedOverruns(ctx.schema)
    expect(rows.map(row => row.count)).toEqual([1, 1])
    expect(rows[1].since).toBe(rows[1].until)
  })

  it('emits but does not write without persistWarnings', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    await boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })
    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => { await delay(1200) })

    await helper.until(() => warnings.length === 1, 10000)
    await boss.stop({ graceful: false })

    expect(await storedOverruns(ctx.schema)).toEqual([])
  })
})
