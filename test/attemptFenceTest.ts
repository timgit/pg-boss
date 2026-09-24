import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import type * as types from '../src/types.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

// A worker whose claim lapses keeps running its handler (#925). These tests take the claim away with
// an operator fail() rather than waiting out a heartbeat, which leaves the job exactly where a
// supervisor heartbeat or expiry fail would: back in `retry`, then claimed again by someone else at
// a higher retryCount. When the stale handler finally returns, none of its settles may land on that
// newer attempt.

async function until (check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await check()) return
    await delay(50)
  }

  throw new Error('condition was not met in time')
}

// Starts a worker whose handler holds its job until released, then takes the claim away from it and
// claims the job again with fetch(), as another worker would. Returns the newer attempt.
async function staleWorker (options: types.WorkOptions & { transactional?: boolean }, handler: (jobs: types.Job[], tx?: types.IDatabase) => Promise<unknown>) {
  const boss = ctx.boss!
  const jobId = await boss.send(ctx.schema, { n: 1 }, { retryLimit: 5, retryDelay: 0 })
  assertTruthy(jobId)

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = false
  let calls = 0

  await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5, ...options } as any, async (jobs: types.Job[], tx?: types.IDatabase) => {
    // Only the first attempt is the stale one; any later pickup would muddy what the test measures.
    if (calls++) return new Promise(() => {})
    entered = true
    await gate
    return handler(jobs, tx)
  })

  await until(async () => entered)
  await boss.fail(ctx.schema, jobId, new Error('claim taken away'))

  const [newer] = await boss.fetch(ctx.schema, { includeMetadata: true })
  assertTruthy(newer)
  expect(newer.id).toBe(jobId)
  expect(newer.retryCount).toBe(1)

  return { jobId, newer, release }
}

async function expectNewerAttemptUntouched (jobId: string) {
  const job = await ctx.boss!.getJobById(ctx.schema, jobId)
  assertTruthy(job)
  expect(job.state).toBe('active')
  expect(job.retryCount).toBe(1)
}

describe('attempt fence', function () {
  it('should expose the retryCount a job was fetched with without includeMetadata', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.retryCount).toBe(0)
  })

  it('should not let a stale worker complete a newer attempt', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const { jobId, release } = await staleWorker({}, async () => ({ by: 'stale' }))

    release()
    await delay(1000)
    await expectNewerAttemptUntouched(jobId)

    const result = await ctx.boss.complete(ctx.schema, jobId, { by: 'newer' })
    expect(result.affected).toBe(1)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    expect(job?.output).toEqual({ by: 'newer' })
  })

  it('should not let a stale worker fail a newer attempt', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const { jobId, release } = await staleWorker({}, async () => { throw new Error('stale handler failed') })

    release()
    await delay(1000)
    await expectNewerAttemptUntouched(jobId)
  })

  it('should not let a stale worker refresh the heartbeat of a newer attempt', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 10 })

    const { jobId, release } = await staleWorker({ heartbeatRefreshSeconds: 0.2 }, async () => {})

    const before = await ctx.boss.getJobById(ctx.schema, jobId)
    await delay(1000)
    const after = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(after?.heartbeatOn).toEqual(before?.heartbeatOn)

    release()
  })

  it('should not let a stale perJobResults worker complete a newer attempt', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const completer = await staleWorker({ perJobResults: true }, async jobs => jobs.map(job => ({ id: job.id, status: 'completed' })))
    completer.release()
    await delay(1000)
    await expectNewerAttemptUntouched(completer.jobId)
  })

  it('should not let a stale perJobResults worker fail a newer attempt', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const failer = await staleWorker({ perJobResults: true }, async jobs => jobs.map(job => ({ id: job.id, status: 'failed' })))
    failer.release()
    await delay(1000)
    await expectNewerAttemptUntouched(failer.jobId)
  })

  it('should not let a stale perJobResults worker dead letter a newer attempt', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const deadLetterer = await staleWorker({ perJobResults: true }, async jobs => jobs.map(job => ({ id: job.id, status: 'deadletter' })))
    deadLetterer.release()
    await delay(1000)
    await expectNewerAttemptUntouched(deadLetterer.jobId)
  })

  it('should not let a shutdown fail a newer attempt the stopping worker lost', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const { jobId } = await staleWorker({}, async () => {})

    // Never released: the stop times out and failWip() fails what the worker still holds.
    await ctx.boss.stop({ timeout: 1000, close: false })
    await delay(500)

    await expectNewerAttemptUntouched(jobId)
  })

  describe('jobs passed in place of ids', function () {
    // A manual fetch() consumer whose claim lapsed: the job is failed out from under it and fetched
    // again, then the original consumer settles the job it was handed.
    async function lapsedFetch () {
      const boss = ctx.boss!
      const jobId = await boss.send(ctx.schema, { n: 1 }, { retryLimit: 5, retryDelay: 0 })
      assertTruthy(jobId)

      const [stale] = await boss.fetch(ctx.schema)
      await boss.fail(ctx.schema, jobId, new Error('claim taken away'))
      const [newer] = await boss.fetch(ctx.schema)
      expect(newer.retryCount).toBe(stale.retryCount + 1)

      return { jobId, stale, newer }
    }

    const settles: Record<string, (job: types.JobAttempt | types.JobAttempt[]) => Promise<types.CommandResponse>> = {
      complete: job => ctx.boss!.complete(ctx.schema, job, { by: 'stale' }),
      fail: job => ctx.boss!.fail(ctx.schema, job, { by: 'stale' }),
      cancel: job => ctx.boss!.cancel(ctx.schema, job),
      deleteJob: job => ctx.boss!.deleteJob(ctx.schema, job),
      touch: job => ctx.boss!.touch(ctx.schema, job)
    }

    for (const [method, settle] of Object.entries(settles)) {
      it(`should leave a newer attempt alone when ${method}() is given the stale job`, async function () {
        ctx.boss = await helper.start(ctx.bossConfig)

        const { jobId, stale } = await lapsedFetch()
        const before = await ctx.boss.getJobById(ctx.schema, jobId)

        const result = await settle(stale)

        expect(result.affected).toBe(0)
        expect(result.jobs).toEqual([jobId])
        await expectNewerAttemptUntouched(jobId)

        const after = await ctx.boss.getJobById(ctx.schema, jobId)
        expect(after?.heartbeatOn).toEqual(before?.heartbeatOn)
      })

      it(`should settle the attempt that was fetched when ${method}() is given the current job`, async function () {
        ctx.boss = await helper.start(ctx.bossConfig)

        const { newer } = await lapsedFetch()

        const result = await settle([{ id: newer.id, retryCount: newer.retryCount }])

        expect(result.affected).toBe(1)
      })
    }

    it('should still settle whatever attempt holds the job when given a plain id', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const { jobId } = await lapsedFetch()

      const result = await ctx.boss.complete(ctx.schema, jobId, { by: 'stale' })

      expect(result.affected).toBe(1)
    })

    // The id lookup takes a uuid parameter, so it accepts every spelling the type does. The fence has
    // to accept the same ones, or a job the lookup matched would silently miss it.
    const spellings: Record<string, (id: string) => string> = {
      'upper case': id => id.toUpperCase(),
      braces: id => `{${id}}`,
      'no hyphens': id => id.replace(/-/g, ''),
      'upper case in braces without hyphens': id => `{${id.replace(/-/g, '').toUpperCase()}}`
    }

    for (const [spelling, spell] of Object.entries(spellings)) {
      it(`should fence a job whose id is spelled with ${spelling}`, async function () {
        ctx.boss = await helper.start(ctx.bossConfig)

        const { stale, newer } = await lapsedFetch()

        const missed = await ctx.boss.complete(ctx.schema, { id: spell(stale.id), retryCount: stale.retryCount })
        expect(missed.affected).toBe(0)

        const landed = await ctx.boss.complete(ctx.schema, { id: spell(newer.id), retryCount: newer.retryCount })
        expect(landed.affected).toBe(1)
      })
    }

    it('should reject a mix of ids and jobs', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      await expect(ctx.boss.complete(ctx.schema, [crypto.randomUUID(), { id: crypto.randomUUID(), retryCount: 0 }] as any))
        .rejects.toThrow('complete() requires either ids or jobs with an id and an integer retryCount, not a mix')
    })

    it('should reject a job without an integer retryCount', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      await expect(ctx.boss.fail(ctx.schema, { id: crypto.randomUUID() } as any))
        .rejects.toThrow('fail() requires either ids or jobs with an id and an integer retryCount, not a mix')
      await expect(ctx.boss.touch(ctx.schema, { id: crypto.randomUUID(), retryCount: 1.5 }))
        .rejects.toThrow('touch() requires either ids or jobs with an id and an integer retryCount, not a mix')
    })
  })

  helper.describePglite('transactional', function () {
    it('should roll back a stale transactional handler instead of completing a newer attempt', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const ledger = `${ctx.schema}.ledger`
      const db = ctx.boss.getDb()
      await db.executeSql(`CREATE TABLE ${ledger} (id serial primary key)`)

      const { jobId, release } = await staleWorker({ transactional: true }, async (_jobs, tx) => {
        await tx!.executeSql(`INSERT INTO ${ledger} DEFAULT VALUES`)
      })

      release()
      await delay(1000)
      await expectNewerAttemptUntouched(jobId)

      const { rows } = await db.executeSql(`SELECT id FROM ${ledger}`)
      expect(rows.length).toBe(0)
    })

    // The handler's own settle goes through the public API with { db: tx }, which the worker cannot
    // pass a fence to, and #assertClaimHeld counts whatever it touches as the handler's. Unfenced, it
    // lands on the newer attempt, the counts agree, and the stale handler's writes commit.
    const settles: Record<string, (id: string, tx: types.IDatabase) => Promise<unknown>> = {
      complete: (id, tx) => ctx.boss!.complete(ctx.schema, id, { by: 'stale' }, { db: tx }),
      fail: (id, tx) => ctx.boss!.fail(ctx.schema, id, { by: 'stale' }, { db: tx }),
      cancel: (id, tx) => ctx.boss!.cancel(ctx.schema, id, { db: tx }),
      deleteJob: (id, tx) => ctx.boss!.deleteJob(ctx.schema, id, { db: tx })
    }

    for (const [method, settle] of Object.entries(settles)) {
      it(`should roll back a stale transactional handler that settles its own job with ${method}()`, async function () {
        ctx.boss = await helper.start(ctx.bossConfig)

        const ledger = `${ctx.schema}.ledger`
        const db = ctx.boss.getDb()
        await db.executeSql(`CREATE TABLE ${ledger} (id serial primary key)`)

        const { jobId, release } = await staleWorker({ transactional: true }, async (jobs, tx) => {
          await tx!.executeSql(`INSERT INTO ${ledger} DEFAULT VALUES`)
          await settle(jobs[0].id, tx!)
        })

        release()
        await delay(1000)
        await expectNewerAttemptUntouched(jobId)

        const { rows } = await db.executeSql(`SELECT id FROM ${ledger}`)
        expect(rows.length).toBe(0)
      })
    }
  })
})
