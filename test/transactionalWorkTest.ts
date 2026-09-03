import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

// PGlite is a single in-process connection supplied as a `db` adapter, which has no
// beginTransaction, so transactional workers are unavailable there by design.
const describeTransactional = helper.describePglite

// Waits for a condition the worker satisfies asynchronously, rather than sleeping a fixed budget.
async function until (check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await check()) return
    await delay(50)
  }

  throw new Error('condition was not met in time')
}

describeTransactional('transactional work', function () {
  it('should commit handler writes with the job completion', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const sideEffects = `${ctx.schema}.side_effect`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${sideEffects} (job_id uuid primary key)`)

    const jobId = await ctx.boss.send(ctx.schema, { work: true })
    helper.assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      await tx.executeSql(`INSERT INTO ${sideEffects} (job_id) VALUES ($1)`, [jobs[0].id])
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    const { rows } = await db.executeSql(`SELECT job_id FROM ${sideEffects}`)

    expect(rows.length).toBe(1)
    expect(rows[0].job_id).toBe(jobId)
  })

  it('should roll handler writes back when the handler throws', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const sideEffects = `${ctx.schema}.side_effect`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${sideEffects} (job_id uuid primary key)`)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 0 })
    helper.assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      await tx.executeSql(`INSERT INTO ${sideEffects} (job_id) VALUES ($1)`, [jobs[0].id])
      throw new Error('handler exploded')
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'failed'
    })

    const { rows } = await db.executeSql(`SELECT job_id FROM ${sideEffects}`)

    expect(rows.length).toBe(0)
  })

  it('should still apply retry accounting after a rollback', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 1, retryDelay: 0 })
    helper.assertTruthy(jobId)

    let attempts = 0

    await ctx.boss.work(ctx.schema, { transactional: true, pollingIntervalSeconds: 0.5 }, async () => {
      attempts++
      throw new Error('handler exploded')
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'failed'
    })

    // the rollback un-fetches the job, so the retry has to come from fail(), not from the job
    // simply reappearing in created
    expect(attempts).toBe(2)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(job.retryCount).toBe(1)
  })

  it('should dead letter a transactional job whose retries run out', async function () {
    const deadLetter = `${ctx.schema}_dlq`

    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 0 })
    helper.assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { transactional: true }, async () => {
      throw new Error('handler exploded')
    })

    await until(async () => {
      const [job] = await ctx.boss!.fetch(deadLetter)
      return !!job
    })
  })

  it('should let the handler complete a job itself through the transaction', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true })
    helper.assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      await ctx.boss!.complete(ctx.schema, jobs[0].id, { settledBy: 'handler' }, { db: tx })
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    const job = await ctx.boss.getJobById<object>(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(job.output).toEqual({ settledBy: 'handler' })
  })

  it('should process a batch as one unit', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids: string[] = []

    for (let i = 0; i < 3; i++) {
      const id: string | null = await ctx.boss.send(ctx.schema, { seq: i })
      helper.assertTruthy(id)
      ids.push(id)
    }

    let seen = 0

    await ctx.boss.work(ctx.schema, { transactional: true, batchSize: 3 }, async (jobs) => {
      seen = jobs.length
    })

    await until(async () => {
      const jobs = await Promise.all(ids.map(id => ctx.boss!.getJobById(ctx.schema, id)))
      return jobs.every(job => job?.state === 'completed')
    })

    expect(seen).toBe(3)
  })

  it('should return a job to the queue when the transaction never commits', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 5 })
    helper.assertTruthy(jobId)

    const workerId = await ctx.boss.work(ctx.schema, { transactional: true }, async () => {
      throw new Error('handler exploded')
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.retryCount === 1
    })

    await ctx.boss.offWork(ctx.schema, { id: workerId })

    // no orphaned active row: the rollback returned the job to the queue rather than leaving it
    // active until expireInSeconds elapsed
    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(job.state).not.toBe('active')
  })

  it('should reject a transactional worker on a db without transaction support', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // an adapter-style db exposing only executeSql, which is the documented minimum
    const inner = ctx.boss.getDb()
    const bare = { executeSql: (text: string, values?: unknown[]) => inner.executeSql(text, values) }

    const boss2 = new PgBoss({ ...ctx.bossConfig, db: bare, createSchema: false, migrate: false })

    await boss2.start()

    try {
      await expect(async () => {
        await boss2.work(ctx.schema, { transactional: true }, async () => {})
      }).rejects.toThrow(/beginTransaction/)
    } finally {
      await boss2.stop({ graceful: false })
    }
  })
})

// Option validation needs no database transaction support, so it runs on every backend.
describe('transactional work options', function () {
  it('should reject a non-boolean transactional option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-expect-error deliberately passing the wrong type
      await ctx.boss.work(ctx.schema, { transactional: 'yes' }, async () => {})
    }).rejects.toThrow(/transactional must be a boolean/)
  })

  it('should reject transactional combined with perJobResults', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { transactional: true, perJobResults: true }, async () => [])
    }).rejects.toThrow(/perJobResults/)
  })

  it('should reject transactional combined with groupConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { transactional: true, groupConcurrency: 2 }, async () => {})
    }).rejects.toThrow(/groupConcurrency/)
  })

  it('should reject transactional combined with localGroupConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { transactional: true, localGroupConcurrency: 2 }, async () => {})
    }).rejects.toThrow(/localGroupConcurrency/)
  })
})
