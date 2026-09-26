import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import type * as types from '../src/types.ts'
import type { JobAttempt } from '../src/index.ts'
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

// Every test runs twice: on the standard statements, and on the split statements a distributed
// backend uses (__test__distributed), which carry their own copy of the fence.
for (const distributed of [false, true]) {
  const config = (extra: Record<string, unknown> = {}) => ({ ...ctx.bossConfig, ...(distributed ? { __test__distributed: true } : {}), ...extra })

  describe(`attempt fence (${distributed ? 'distributed' : 'standard'})`, function () {
    it('should expose the retryCount a job was fetched with without includeMetadata', async function () {
      ctx.boss = await helper.start(config())
      await ctx.boss.send(ctx.schema)

      const [job] = await ctx.boss.fetch(ctx.schema)

      expect(job.retryCount).toBe(0)
    })

    it('should not let a stale worker complete a newer attempt', async function () {
      ctx.boss = await helper.start(config())

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
      ctx.boss = await helper.start(config())

      const { jobId, release } = await staleWorker({}, async () => { throw new Error('stale handler failed') })

      release()
      await delay(1000)
      await expectNewerAttemptUntouched(jobId)
    })

    it('should not let a stale worker refresh the heartbeat of a newer attempt', async function () {
      ctx.boss = await helper.start(config())
      await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 10 })

      const { jobId, release } = await staleWorker({ heartbeatRefreshSeconds: 0.2 }, async () => {})

      const before = await ctx.boss.getJobById(ctx.schema, jobId)
      await delay(1000)
      const after = await ctx.boss.getJobById(ctx.schema, jobId)

      expect(after?.heartbeatOn).toEqual(before?.heartbeatOn)

      release()
    })

    it('should not let a stale perJobResults worker complete a newer attempt', async function () {
      ctx.boss = await helper.start(config())

      const completer = await staleWorker({ perJobResults: true }, async jobs => jobs.map(job => ({ id: job.id, status: 'completed' })))
      completer.release()
      await delay(1000)
      await expectNewerAttemptUntouched(completer.jobId)
    })

    it('should not let a stale perJobResults worker fail a newer attempt', async function () {
      ctx.boss = await helper.start(config())

      const failer = await staleWorker({ perJobResults: true }, async jobs => jobs.map(job => ({ id: job.id, status: 'failed' })))
      failer.release()
      await delay(1000)
      await expectNewerAttemptUntouched(failer.jobId)
    })

    it('should not let a stale perJobResults worker dead letter a newer attempt', async function () {
      ctx.boss = await helper.start(config())

      const deadLetterer = await staleWorker({ perJobResults: true }, async jobs => jobs.map(job => ({ id: job.id, status: 'deadletter' })))
      deadLetterer.release()
      await delay(1000)
      await expectNewerAttemptUntouched(deadLetterer.jobId)
    })

    it('should not let a shutdown fail a newer attempt the stopping worker lost', async function () {
      ctx.boss = await helper.start(config())

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

      const settles: Record<string, (job: JobAttempt | JobAttempt[]) => Promise<types.CommandResponse>> = {
        complete: job => ctx.boss!.complete(ctx.schema, job, { by: 'stale' }),
        fail: job => ctx.boss!.fail(ctx.schema, job, { by: 'stale' }),
        cancel: job => ctx.boss!.cancel(ctx.schema, job),
        deleteJob: job => ctx.boss!.deleteJob(ctx.schema, job),
        touch: job => ctx.boss!.touch(ctx.schema, job)
      }

      for (const [method, settle] of Object.entries(settles)) {
        it(`should leave a newer attempt alone when ${method}() is given the stale job`, async function () {
          ctx.boss = await helper.start(config())

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
          ctx.boss = await helper.start(config())

          const { newer } = await lapsedFetch()

          const result = await settle([{ id: newer.id, retryCount: newer.retryCount }])

          expect(result.affected).toBe(1)
        })
      }

      it('should still settle whatever attempt holds the job when given a plain id', async function () {
        ctx.boss = await helper.start(config())

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
          ctx.boss = await helper.start(config())

          const { stale, newer } = await lapsedFetch()

          const missed = await ctx.boss.complete(ctx.schema, { id: spell(stale.id), retryCount: stale.retryCount })
          expect(missed.affected).toBe(0)

          const landed = await ctx.boss.complete(ctx.schema, { id: spell(newer.id), retryCount: newer.retryCount })
          expect(landed.affected).toBe(1)
        })
      }

      it('should reject a mix of ids and jobs', async function () {
        ctx.boss = await helper.start(config())

        await expect(ctx.boss.complete(ctx.schema, [crypto.randomUUID(), { id: crypto.randomUUID(), retryCount: 0 }] as any))
          .rejects.toThrow('complete() requires either ids or jobs with an id and an integer retryCount, not a mix')
      })

      it('should reject a job without an integer retryCount', async function () {
        ctx.boss = await helper.start(config())

        await expect(ctx.boss.fail(ctx.schema, { id: crypto.randomUUID() } as any))
          .rejects.toThrow('fail() requires either ids or jobs with an id and an integer retryCount, not a mix')
        await expect(ctx.boss.touch(ctx.schema, { id: crypto.randomUUID(), retryCount: 1.5 }))
          .rejects.toThrow('touch() requires either ids or jobs with an id and an integer retryCount, not a mix')
      })
    })

    helper.describePglite('transactional', function () {
      it('should roll back a stale transactional handler instead of completing a newer attempt', async function () {
        ctx.boss = await helper.start(config())

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
          ctx.boss = await helper.start(config())

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

    describe('claim lost while the handler runs', function () {
      // Holds a batch of `count` jobs in one handler until released. `respond` builds the handler's
      // return value; `during` runs inside the handler before it waits, with the batch it was given.
      async function holdBatch (count: number, options: Record<string, unknown> = {}, during?: (jobs: types.Job[]) => Promise<void>) {
        const boss = ctx.boss!
        const ids: string[] = []

        for (let i = 0; i < count; i++) {
          const id = await boss.send(ctx.schema, { i }, { retryLimit: 5, retryDelay: 0 })
          assertTruthy(id)
          ids.push(id)
        }

        let release!: (respond?: (jobs: types.Job[]) => unknown) => void
        const gate = new Promise<((jobs: types.Job[]) => unknown) | undefined>(resolve => { release = resolve })
        let held: types.Job[] = []
        let calls = 0

        await boss.work(ctx.schema, { batchSize: count, pollingIntervalSeconds: 0.5, ...options } as any, async (jobs: types.Job[]) => {
          if (calls++) return new Promise(() => {})
          held = jobs
          await during?.(jobs)
          const respond = await gate
          return respond?.(jobs)
        })

        await until(async () => held.length === count)

        const byId = (id: string) => held.find(job => job.id === id)!

        return { ids, byId, release }
      }

      // Takes a claim the way an operator does, then claims the job again as another worker would.
      async function lose (id: string) {
        await ctx.boss!.fail(ctx.schema, id, new Error('claim taken away'))
        const [newer] = await ctx.boss!.fetch(ctx.schema)
        expect(newer?.id).toBe(id)
      }

      async function expectState (id: string, state: string, retryCount?: number) {
        const job = await ctx.boss!.getJobById(ctx.schema, id)
        expect(job?.state).toBe(state)
        if (retryCount !== undefined) expect(job?.retryCount).toBe(retryCount)
      }

      it('should settle nothing after the supervisor fails a stale heartbeat and another worker claims the job', async function () {
        ctx.boss = await helper.start(config())
        await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 10 })

        const { ids: [id], release } = await holdBatch(1, { heartbeatRefreshSeconds: 9 })

        // The production path: the heartbeat goes stale, the supervisor fails the job back to retry,
        // and another worker claims it.
        await ctx.boss.getDb().executeSql(`UPDATE ${ctx.schema}.job SET heartbeat_on = heartbeat_on - interval '1 hour' WHERE id = $1`, [id])
        await ctx.boss.supervise(ctx.schema)
        const [newer] = await ctx.boss.fetch(ctx.schema)
        expect(newer?.id).toBe(id)
        expect(newer?.retryCount).toBe(1)

        release(() => ({ by: 'stale' }))
        await delay(1000)

        const job = await ctx.boss.getJobById(ctx.schema, id)
        expect(job?.state).toBe('active')
        expect(job?.retryCount).toBe(1)
        expect(job?.output).toEqual({ value: { message: 'job heartbeat timeout' } })
      })

      it('should abort the signal of a job whose claim was lost, and only that job', async function () {
        ctx.boss = await helper.start(config())
        await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 10 })

        const { ids: [lostId, heldId], byId, release } = await holdBatch(2, { heartbeatRefreshSeconds: 0.3 })

        await lose(lostId)
        await until(async () => byId(lostId).signal.aborted, 5000)

        expect(byId(lostId).signal.reason?.message).toBe(`job ${lostId} is no longer active under this worker's claim`)
        expect(byId(heldId).signal.aborted).toBe(false)

        release(() => ({ by: 'batch' }))
        await until(async () => (await ctx.boss!.getJobById(ctx.schema, heldId))?.state === 'completed')

        await expectState(lostId, 'active', 1)
      })

      it('should not abort the rest of a batch whose handler settled one of its own jobs early', async function () {
        ctx.boss = await helper.start(config())
        await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 10 })

        let earlyId = ''
        const { ids, byId, release } = await holdBatch(2, { heartbeatRefreshSeconds: 0.3 }, async jobs => {
          earlyId = jobs[0].id
          await ctx.boss!.complete(ctx.schema, jobs[0], { early: true })
        })
        const laterId = ids.find(id => id !== earlyId)!

        // Several heartbeats run with one of the two jobs no longer active.
        await delay(1500)

        expect(byId(laterId).signal.aborted).toBe(false)

        release()
        await until(async () => (await ctx.boss!.getJobById(ctx.schema, laterId))?.state === 'completed')
        await expectState(earlyId, 'completed')
      })

      it('should not abort anything when a heartbeat fails to reach the database', async function () {
        ctx.boss = await helper.start(config())
        await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 10 })

        const errors: unknown[] = []
        ctx.boss.on('error', err => errors.push(err))

        const db = ctx.boss.getDb()
        const executeSql = db.executeSql
        const spy = vi.spyOn(db, 'executeSql').mockImplementation(function (text, values) {
          if (text.includes('SET heartbeat_on =')) throw new Error('heartbeat unreachable')
          return executeSql.call(db, text, values)
        })

        try {
          const { ids: [id], byId, release } = await holdBatch(1, { heartbeatRefreshSeconds: 0.3 })

          await until(async () => errors.length > 1)
          expect(byId(id).signal.aborted).toBe(false)

          release()
          await until(async () => (await ctx.boss!.getJobById(ctx.schema, id))?.state === 'completed')
        } finally {
          spy.mockRestore()
        }
      })

      it('should not abort anything when the heartbeat cannot say which jobs it refreshed', async function () {
        ctx.boss = await helper.start(config())
        await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 10 })

        // A driver that returns the count without the ids array.
        const db = ctx.boss.getDb()
        const executeSql = db.executeSql
        let heartbeats = 0
        const spy = vi.spyOn(db, 'executeSql').mockImplementation(async function (text, values) {
          if (!text.includes('SET heartbeat_on =')) return executeSql.call(db, text, values)
          heartbeats++
          return { rows: [{ count: '0' }] }
        })

        try {
          const { ids: [id], byId, release } = await holdBatch(1, { heartbeatRefreshSeconds: 0.3 })

          await until(async () => heartbeats > 1)
          expect(byId(id).signal.aborted).toBe(false)

          release()
          await until(async () => (await ctx.boss!.getJobById(ctx.schema, id))?.state === 'completed')
        } finally {
          spy.mockRestore()
        }
      })

      it('should settle only the jobs it still holds in a batch', async function () {
        ctx.boss = await helper.start(config())

        const { ids: [lostId, heldId], release } = await holdBatch(2)

        await lose(lostId)
        release(() => ({ by: 'batch' }))

        await until(async () => (await ctx.boss!.getJobById(ctx.schema, heldId))?.state === 'completed')
        await expectState(lostId, 'active', 1)
      })

      for (const status of ['completed', 'failed', 'deadletter'] as const) {
        it(`should settle only the jobs it still holds in a perJobResults batch (${status})`, async function () {
          ctx.boss = await helper.start(config({ __test__enableSpies: true }))
          const spy = ctx.boss.getSpy(ctx.schema)

          const { ids: [lostId, heldId], release } = await holdBatch(2, { perJobResults: true })

          await lose(lostId)
          release(jobs => jobs.map(job => ({ id: job.id, status, output: { by: 'batch' } })))

          const settledState = status === 'completed' ? 'completed' : 'failed'
          await spy.waitForJobWithId(heldId, settledState)
          await expectState(lostId, 'active', 1)

          // The spy records what landed, not what the handler asked for.
          const recorded = await Promise.race([spy.waitForJobWithId(lostId, settledState).then(() => true), delay(500).then(() => false)])
          expect(recorded).toBe(false)
        })
      }
    })
  })
}
