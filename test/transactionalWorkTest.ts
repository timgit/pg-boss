import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import type * as types from '../src/types.ts'
import * as plans from '../src/plans.ts'
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

// The bound pg-boss applied, in milliseconds, read from inside the handler's transaction.
// pg_settings rather than current_setting: it reports both GUCs unitless on every backend, where
// current_setting spells the same 35 seconds '35s' on PostgreSQL and '35000' on CockroachDB.
// Null when the server recognises neither GUC and the transaction ran unbounded.
async function readTransactionBound (tx: types.IDatabase): Promise<number | null> {
  const { rows } = await tx.executeSql(
    `SELECT name, setting::bigint AS ms FROM pg_settings
      WHERE name IN ('transaction_timeout', 'idle_in_transaction_session_timeout')
      ORDER BY name = 'transaction_timeout' DESC`)

  return rows.length ? Number(rows[0].ms) : null
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

  it('should leave the job active and readable outside the transaction while the handler runs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true })
    helper.assertTruthy(jobId)

    let stateDuringHandler: string | undefined

    // The claim is committed before the transaction opens, which is what leaves every supervision
    // path (timeouts, heartbeats, another instance's monitor) able to see the job it is holding.
    await ctx.boss.work(ctx.schema, { transactional: true }, async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      stateDuringHandler = job?.state
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    expect(stateDuringHandler).toBe('active')
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

    // one retry, then terminal: the rollback takes the handler's writes and nothing else, so the
    // attempt the fetch recorded still counts
    expect(attempts).toBe(2)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(job.retryCount).toBe(1)
  })

  it('should dead letter a transactional job whose retries run out', async function () {
    const deadLetter = `${ctx.schema}_dlq`

    // noDefault so the source queue is created here, with its dead letter queue attached: the
    // default helper queue already exists without one, and createQueue would not add it.
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

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

  it('should let the supervisor reclaim a transactional job whose handler never returns', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { retryLimit: 0 })

    const jobId = await ctx.boss.send(ctx.schema, { work: true })
    helper.assertTruthy(jobId)

    let releaseHandler = () => {}
    let handlerStarted = false

    await ctx.boss.work(ctx.schema, { transactional: true }, async () => {
      handlerStarted = true
      await new Promise<void>(resolve => { releaseHandler = resolve })
    })

    await until(async () => handlerStarted)

    // Backdate the claim past its expiration, the way a process that died holding the transaction
    // would look to the next supervise pass.
    const db = await helper.getDb()

    try {
      await db.executeSql(`UPDATE ${ctx.schema}.job SET started_on = now() - interval '1 hour' WHERE id = $1`, [jobId])
    } finally {
      await db.close()
    }

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(job.state).toBe('failed')
    expect(job.output).toEqual({ value: { message: 'job timed out' } })

    releaseHandler()
  })

  // Skipped where the backend cannot carry both: the refresh writes the claimed row from outside
  // the handler transaction, which CockroachDB then refuses the completion a write to. The
  // rejection that replaces it is covered by the two tests below.
  it.skipIf(helper.isCockroachDb)('should refresh the heartbeat while a transactional handler runs', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10 })

    const jobId = await ctx.boss.send(ctx.schema, { work: true })
    helper.assertTruthy(jobId)

    const db = await helper.getDb()

    const readHeartbeat = async () => {
      const { rows } = await db.executeSql(`SELECT heartbeat_on FROM ${ctx.schema}.job WHERE id = $1`, [jobId])
      return rows[0].heartbeat_on.getTime() as number
    }

    let refreshed = false

    // The heartbeat runs on a pooled connection against the claimed row, so it reaches the job a
    // transactional handler is holding just as it does any other.
    await ctx.boss.work(ctx.schema, { transactional: true, heartbeatRefreshSeconds: 0.5 }, async () => {
      const before = await readHeartbeat()
      await until(async () => (await readHeartbeat()) > before)
      refreshed = true
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    await db.close()

    expect(refreshed).toBe(true)
  })

  it('should reject a transactional worker on a heartbeat queue where the backend cannot carry both', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, __test__noTransactionalHeartbeat: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10 })

    await expect(ctx.boss.work(ctx.schema, { transactional: true }, async () => {}))
      .rejects.toThrow('cannot run a transactional worker on a queue with heartbeatSeconds')

    // The same queue without the transaction is untouched: only the combination is refused.
    const workerId = await ctx.boss.work(ctx.schema, async () => {})
    expect(workerId).toBeTruthy()
  })

  it('should fail a batch a per-job heartbeat put on a queue that has none', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__noTransactionalHeartbeat: true })

    // The queue carries no heartbeat, so work() has nothing to refuse and the worker registers.
    // The job brings its own, which only the batch can see.
    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { heartbeatSeconds: 10, retryLimit: 0 })
    helper.assertTruthy(jobId)

    let handled = false

    await ctx.boss.work(ctx.schema, { transactional: true }, async () => {
      handled = true
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'failed'
    })

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)

    // Refused before the handler and before the begin, so there is no transaction to conflict with
    // and no raw write conflict in the output. The message names the job and updateQueue() rather
    // than the queue's own configuration, which is correct here and has nothing to drop.
    expect(handled).toBe(false)
    expect(JSON.stringify(job.output)).toContain('cannot run a transactional handler over a job with heartbeatSeconds')
    expect(JSON.stringify(job.output)).toContain('came from the job (heartbeatSeconds on send()) or from updateQueue()')
  })

  it('should work with localGroupConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids: string[] = []

    for (let i = 0; i < 2; i++) {
      const id: string | null = await ctx.boss.send(ctx.schema, { seq: i }, { group: { id: 'tx-group' } })
      helper.assertTruthy(id)
      ids.push(id)
    }

    await ctx.boss.work(ctx.schema, { transactional: true, localGroupConcurrency: 1, pollingIntervalSeconds: 0.5 }, async () => {})

    await until(async () => {
      const jobs = await Promise.all(ids.map(id => ctx.boss!.getJobById(ctx.schema, id)))
      return jobs.every(job => job?.state === 'completed')
    })
  })

  it('should work with groupConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids: string[] = []

    for (let i = 0; i < 2; i++) {
      const id: string | null = await ctx.boss.send(ctx.schema, { seq: i }, { group: { id: 'tx-group' } })
      helper.assertTruthy(id)
      ids.push(id)
    }

    await ctx.boss.work(ctx.schema, { transactional: true, groupConcurrency: 1, pollingIntervalSeconds: 0.5 }, async () => {})

    await until(async () => {
      const jobs = await Promise.all(ids.map(id => ctx.boss!.getJobById(ctx.schema, id)))
      return jobs.every(job => job?.state === 'completed')
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

  it('should roll back a handler abandoned by a shutdown', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const sideEffects = `${ctx.schema}.side_effect`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${sideEffects} (note text)`)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 0 })
    helper.assertTruthy(jobId)

    let handlerTx: types.IDatabase | undefined
    let firstHalfWritten = false

    // Half the handler's work is in the database and the rest never runs, which is what a
    // non-graceful stop does to any handler it catches mid-flight.
    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      handlerTx = tx
      await tx.executeSql(`INSERT INTO ${sideEffects} (note) VALUES ('first-half')`)
      firstHalfWritten = true
      await delay(1000)
      await tx.executeSql(`INSERT INTO ${sideEffects} (note) VALUES ('second-half')`)
    })

    await until(async () => firstHalfWritten)

    await ctx.boss.stop({ graceful: false, close: false })

    // The transaction refusing statements is the worker having settled it, which is what the
    // assertions below are waiting on: an uncommitted insert is invisible from another connection
    // either way, so an empty table only means anything once the transaction is over.
    await until(async () => {
      try {
        await handlerTx!.executeSql('SELECT 1')
        return false
      } catch {
        return true
      }
    })

    const { rows } = await db.executeSql(`SELECT note FROM ${sideEffects}`)

    expect(rows.length).toBe(0)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(job.state).toBe('failed')
  })

  it('should roll back when the claim is lost while the handler runs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ledger = `${ctx.schema}.ledger`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${ledger} (id serial primary key)`)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 5, retryDelay: 0 })
    helper.assertTruthy(jobId)

    let attempts = 0
    let stolen = false

    await ctx.boss.work(ctx.schema, { transactional: true, pollingIntervalSeconds: 0.5 }, async (jobs, tx) => {
      attempts++
      await tx.executeSql(`INSERT INTO ${ledger} DEFAULT VALUES`)

      if (!stolen) {
        stolen = true
        // On a pooled connection, so it is the job being taken away from this handler rather than
        // the handler settling it: an operator's fail(), a heartbeat the database stopped seeing,
        // expireInSeconds, another instance's supervisor. Committing here would leave the ledger
        // row under a job that is about to run again.
        await ctx.boss!.fail(ctx.schema, jobs[0].id, new Error('stolen'))
      }
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    const { rows } = await db.executeSql(`SELECT id FROM ${ledger}`)

    // One row for two attempts: the stolen one rolled back, the one that kept its claim committed.
    expect(attempts).toBe(2)
    expect(rows.length).toBe(1)
  })

  it('should roll back when the handler settles a claim it no longer holds', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ledger = `${ctx.schema}.ledger`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${ledger} (id serial primary key)`)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 5, retryDelay: 0 })
    helper.assertTruthy(jobId)

    let attempts = 0
    let stolen = false
    const selfSettled: number[] = []

    await ctx.boss.work(ctx.schema, { transactional: true, pollingIntervalSeconds: 0.5 }, async (jobs, tx) => {
      attempts++
      await tx.executeSql(`INSERT INTO ${ledger} DEFAULT VALUES`)

      if (!stolen) {
        stolen = true
        await ctx.boss!.fail(ctx.schema, jobs[0].id, new Error('stolen'))
      }

      // The documented pattern, run on an attempt whose claim is already gone. It asks to settle
      // and updates nothing, which is indistinguishable from a lost claim until the count is read:
      // counting the ask rather than the row would account for a job nobody settled and commit the
      // ledger row under a job about to run again.
      const response = await ctx.boss!.complete(ctx.schema, jobs[0].id, undefined, { db: tx })
      selfSettled.push(response.affected)
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    const { rows } = await db.executeSql(`SELECT id FROM ${ledger}`)

    expect(attempts).toBe(2)
    // CockroachDB answers the handler's own settle on a row a peer just moved with a 40001 retry
    // error rather than affected: 0, so the first attempt throws before it reaches the reading.
    // Either way the batch rolls back, which is what the one ledger row asserts.
    expect(selfSettled).toEqual(helper.isCockroachDb ? [1] : [0, 1])
    expect(rows.length).toBe(1)
  })

  it('should commit when the handler settles part of its own batch first', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ledger = `${ctx.schema}.ledger`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${ledger} (id serial primary key)`)

    const ids: string[] = []

    for (let i = 0; i < 2; i++) {
      const id: string | null = await ctx.boss.send(ctx.schema, { seq: i })
      helper.assertTruthy(id)
      ids.push(id)
    }

    const settles: Array<{ cancelled: number, completed: number, requested: number }> = []

    await ctx.boss.work(ctx.schema, { transactional: true, batchSize: 2 }, async (jobs, tx) => {
      await tx.executeSql(`INSERT INTO ${ledger} DEFAULT VALUES`)

      const cancelled = await ctx.boss!.cancel(ctx.schema, jobs[0].id, { db: tx })
      // Partly redundant by design: one of these two was cancelled a statement ago, so this
      // settles the other. The short count is the handler's own doing, not a lost claim, and
      // reading it as one would throw away a batch that did exactly what it was asked to.
      const completed = await ctx.boss!.complete(ctx.schema, jobs.map(job => job.id), undefined, { db: tx })

      settles.push({ cancelled: cancelled.affected, completed: completed.affected, requested: completed.requested })
    })

    await until(async () => {
      const jobs = await Promise.all(ids.map(id => ctx.boss!.getJobById(ctx.schema, id)))
      return jobs.every(job => job?.state === 'cancelled' || job?.state === 'completed')
    })

    const jobs = await Promise.all(ids.map(id => ctx.boss!.getJobById(ctx.schema, id)))
    const { rows } = await db.executeSql(`SELECT id FROM ${ledger}`)

    expect(settles).toEqual([{ cancelled: 1, completed: 1, requested: 2 }])
    expect(jobs.map(job => job?.state).sort()).toEqual(['cancelled', 'completed'])
    expect(rows.length).toBe(1)
  })

  it('should name the handler in the rollback when it settled the job with its own sql', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 0 })
    helper.assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      // Settling by hand was never supported, and nothing about a raw UPDATE is recognisable as a
      // settle, so this rolls back. The message has to offer that reading too, since no claim was
      // actually lost here.
      await tx.executeSql(`UPDATE ${ctx.schema}.job SET state = 'completed', completed_on = now() WHERE id = $1`, [jobs[0].id])
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'failed'
    })

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(JSON.stringify(job.output)).toContain('settled the job with SQL of its own')
  })

  it('should say so when the handler swallows a SQL error and leaves the transaction aborted', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 0 })
    helper.assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      try {
        await tx.executeSql('SELECT 1 FROM a_table_that_does_not_exist')
      } catch {
        // swallowed on purpose: the transaction stays aborted, so pg-boss's own completion is the
        // statement that trips over it
      }
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'failed'
    })

    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(job)
    expect(JSON.stringify(job.output)).toContain('left its transaction aborted')
  })

  it('should warn when transactional workers leave the pool no headroom', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, max: 2 })

    const warnings: any[] = []
    ctx.boss.on('warning', warning => warnings.push(warning))

    const workerId = await ctx.boss.work(ctx.schema, { transactional: true, localConcurrency: 2 }, async () => {})

    await ctx.boss.offWork(ctx.schema, { id: workerId })

    expect(warnings.some(w => w.data?.type === 'transactional_pool_headroom')).toBe(true)
  })

  it('should keep the pool headroom warning out of the warning table', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, max: 2, persistWarnings: true })

    const warnings: any[] = []
    ctx.boss.on('warning', warning => warnings.push(warning))

    const workerId = await ctx.boss.work(ctx.schema, { transactional: true, localConcurrency: 2 }, async () => {})

    await ctx.boss.offWork(ctx.schema, { id: workerId })

    expect(warnings.some(w => w.data?.type === 'transactional_pool_headroom')).toBe(true)

    const db = await helper.getDb()

    try {
      const { rows } = await db.executeSql(plans.getWarnings(ctx.schema), [null, 10, 0])
      expect(rows.some(row => row.type === 'transactional_pool_headroom')).toBe(false)
    } finally {
      await db.close()
    }
  })

  it('should bound the handler transaction from the database side', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { expireInSeconds: 30 })
    helper.assertTruthy(jobId)

    let applied: number | null | undefined

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      applied = await readTransactionBound(tx)
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    // expireInSeconds plus the 5s pg-boss allows its own rollback, on whichever GUC this server
    // recognises. transaction_timeout arrived in PostgreSQL 17, so older servers get the idle one.
    expect(applied).toBe(35000)
  })

  it('should honour an explicit transactionTimeoutSeconds', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { expireInSeconds: 30 })
    helper.assertTruthy(jobId)

    let applied: number | null | undefined

    await ctx.boss.work(ctx.schema, { transactional: true, transactionTimeoutSeconds: 90 }, async (jobs, tx) => {
      applied = await readTransactionBound(tx)
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    expect(applied).toBe(90000)
  })

  it('should leave the transaction unbounded at transactionTimeoutSeconds 0', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { work: true })
    helper.assertTruthy(jobId)

    let applied: number | null | undefined

    await ctx.boss.work(ctx.schema, { transactional: true, transactionTimeoutSeconds: 0 }, async (jobs, tx) => {
      applied = await readTransactionBound(tx)
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    // 0 is how both GUCs spell "no bound"; a server that has neither reports nothing at all.
    expect(applied === null || applied === 0).toBe(true)
  })

  it('should roll the handler back when the database gives up on its transaction', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const sideEffects = `${ctx.schema}.side_effect`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${sideEffects} (note text)`)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 0, expireInSeconds: 60 })
    helper.assertTruthy(jobId)

    // Below every in-process timer, so the server is what ends this batch. The handler keeps
    // issuing statements, which idle_in_transaction_session_timeout would never catch, so this
    // only asserts on a server that has transaction_timeout.
    await ctx.boss.work(ctx.schema, { transactional: true, transactionTimeoutSeconds: 1 }, async (jobs, tx) => {
      await tx.executeSql(`INSERT INTO ${sideEffects} VALUES ('first-half')`)

      for (let i = 0; i < 15; i++) {
        await delay(100)
        await tx.executeSql('SELECT 1').catch(() => {})
      }
    })

    const bounded = await db.executeSql("SELECT current_setting('transaction_timeout', true) AS guc")

    if (bounded.rows[0].guc === null) return

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'failed'
    }, 4000)

    const { rows } = await db.executeSql(`SELECT note FROM ${sideEffects}`)
    expect(rows.length).toBe(0)
  })

  it('should run unbounded and probe again after a probe the server refused', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const inner = ctx.boss.getDb()
    let probes = 0

    // Refuses the GUC probe once. The batch that hits it still has to run: the database-side bound
    // is a backstop against a process that has already failed, so losing it is worth a warning and
    // nothing more. The batch after it has to ask again, since a remembered rejection would leave
    // every transaction from then on unbounded for the life of the process. The cooldown between
    // the two is switched off here so the second batch is the one that asks.
    const db = {
      executeSql: (text: string, values?: unknown[]) => {
        if (text.includes("current_setting('transaction_timeout'")) {
          probes++

          if (probes === 1) {
            return Promise.reject(new Error('probe refused'))
          }
        }

        return inner.executeSql(text, values)
      },
      beginTransaction: () => inner.beginTransaction!()
    }

    const boss2 = new PgBoss({ ...ctx.bossConfig, db, createSchema: false, migrate: false, __test__transactionTimeoutProbeCooldownMs: 0 })

    const warnings: any[] = []
    boss2.on('warning', warning => warnings.push(warning))

    await boss2.start()

    try {
      const first = await boss2.send(ctx.schema, { work: true }, { retryLimit: 0, expireInSeconds: 30 })
      const second = await boss2.send(ctx.schema, { work: true }, { retryLimit: 0, expireInSeconds: 30 })
      helper.assertTruthy(first)
      helper.assertTruthy(second)

      const bounds: Array<number | null> = []

      // One job per batch, so the refused probe and the successful one land in transactions of
      // their own and the second job only runs once the first is settled.
      await boss2.work(ctx.schema, { transactional: true, batchSize: 1 }, async (jobs, tx) => {
        bounds.push(await readTransactionBound(tx))
      })

      await until(async () => {
        const jobs = await Promise.all([first, second].map(id => boss2.getJobById(ctx.schema, id)))
        return jobs.every(job => job?.state === 'completed')
      })

      // Both committed. The first ran with whatever bound the connection already carried (none, on
      // a stock server), the second with the one pg-boss derived from expireInSeconds.
      expect(probes).toBe(2)
      expect(bounds.length).toBe(2)
      expect(bounds[0] === null || bounds[0] === 0).toBe(true)
      expect(bounds[1]).toBe(35000)
      expect(warnings.filter(w => w.data?.type === 'transaction_timeout_probe').length).toBe(1)
    } finally {
      await boss2.stop({ graceful: false })
    }
  })

  it('should not repeat a refused probe until the cooldown has passed', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const inner = ctx.boss.getDb()
    let probes = 0

    // A server that never answers. Not remembering the rejection is what keeps the retry alive, but
    // asking on every batch for the life of the process is a round trip spent on a question whose
    // answer is not going to change in the next few seconds. The default cooldown holds it to one
    // probe across both batches; the warning is once per process either way.
    const db = {
      executeSql: (text: string, values?: unknown[]) => {
        if (text.includes("current_setting('transaction_timeout'")) {
          probes++
          return Promise.reject(new Error('probe refused'))
        }

        return inner.executeSql(text, values)
      },
      beginTransaction: () => inner.beginTransaction!()
    }

    const boss2 = new PgBoss({ ...ctx.bossConfig, db, createSchema: false, migrate: false })

    const warnings: any[] = []
    boss2.on('warning', warning => warnings.push(warning))

    await boss2.start()

    try {
      const first = await boss2.send(ctx.schema, { work: true }, { retryLimit: 0, expireInSeconds: 30 })
      const second = await boss2.send(ctx.schema, { work: true }, { retryLimit: 0, expireInSeconds: 30 })
      helper.assertTruthy(first)
      helper.assertTruthy(second)

      const bounds: Array<number | null> = []

      await boss2.work(ctx.schema, { transactional: true, batchSize: 1 }, async (jobs, tx) => {
        bounds.push(await readTransactionBound(tx))
      })

      await until(async () => {
        const jobs = await Promise.all([first, second].map(id => boss2.getJobById(ctx.schema, id)))
        return jobs.every(job => job?.state === 'completed')
      })

      expect(probes).toBe(1)
      expect(bounds.length).toBe(2)
      expect(bounds.every(bound => bound === null || bound === 0)).toBe(true)
      expect(warnings.filter(w => w.data?.type === 'transaction_timeout_probe').length).toBe(1)
    } finally {
      await boss2.stop({ graceful: false })
    }
  })

  it('should run unbounded rather than fail the batch when pg_settings cannot be read', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const inner = ctx.boss.getDb()
    let rehearsals = 0

    // A backend, or a db adapter, with the GUC but without the catalog view: current_setting is
    // answered and the probe picks a GUC, then anything reading pg_settings is refused. Applying the
    // bound reads pg_settings as the first statement of the handler's transaction, so without the
    // rehearsal on the pooled connection this would fail every batch, with nothing said to the
    // warning system. The rehearsal takes the failure where it costs the bound and nothing else.
    // Only the pooled connection is wrapped; the handler's transaction comes from the real pool, so
    // the refusal reaches the rehearsal and not the test's own read from inside the handler.
    const db = {
      executeSql: (text: string, values?: unknown[]) => {
        if (text.includes('pg_settings')) {
          rehearsals++
          return Promise.reject(new Error('pg_settings unavailable'))
        }

        return inner.executeSql(text, values)
      },
      beginTransaction: () => inner.beginTransaction!()
    }

    const boss2 = new PgBoss({ ...ctx.bossConfig, db, createSchema: false, migrate: false })

    const warnings: any[] = []
    boss2.on('warning', warning => warnings.push(warning))

    await boss2.start()

    try {
      const jobId = await boss2.send(ctx.schema, { work: true }, { retryLimit: 0, expireInSeconds: 30 })
      helper.assertTruthy(jobId)

      let handled = false
      let bound: number | null | undefined

      await boss2.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
        handled = true
        bound = await readTransactionBound(tx)
      })

      await until(async () => {
        const job = await boss2.getJobById(ctx.schema, jobId)
        return job?.state === 'completed'
      })

      expect(handled).toBe(true)
      expect(rehearsals).toBe(1)
      expect(bound === null || bound === 0).toBe(true)
      expect(warnings.filter(w => w.data?.type === 'transaction_timeout_probe').length).toBe(1)
      expect(warnings[0].message).toContain('pg_settings unavailable')
    } finally {
      await boss2.stop({ graceful: false })
    }
  })

  // Only the GUC this server has, asked the same way pg-boss asks: transaction_timeout where it
  // exists (PostgreSQL 17+, CockroachDB), the idle one on 13-16 and YugabyteDB. -c on a parameter
  // the server does not recognise is refused at connect, so naming both would take the whole pool
  // down on exactly the servers where the fallback matters. -c applies the value to every
  // connection in the pool, which is how a role, a managed provider or a pooler sets it.
  const withOperatorBound = async (ms: number) => {
    const db = await helper.getDb()
    const { rows } = await db.executeSql("SELECT current_setting('transaction_timeout', true) AS tt")
    await db.close()

    const guc = rows[0].tt !== null ? 'transaction_timeout' : 'idle_in_transaction_session_timeout'

    return { ...ctx.bossConfig, options: `-c ${guc}=${ms}` }
  }

  it('should keep an operator bound that is tighter than the derived one', async function () {
    // 3 seconds the DBA set against 35 derived from expireInSeconds. Widening it would happen on
    // exactly the longest transactions pg-boss opens, which is the worst place to do it.
    ctx.boss = await helper.start(await withOperatorBound(3000))

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { expireInSeconds: 30 })
    helper.assertTruthy(jobId)

    let applied: number | null | undefined

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      applied = await readTransactionBound(tx)
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    expect(applied).toBe(3000)
  })

  it('should apply the derived bound over an operator bound that is looser', async function () {
    ctx.boss = await helper.start(await withOperatorBound(600000))

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { expireInSeconds: 30 })
    helper.assertTruthy(jobId)

    let applied: number | null | undefined

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      applied = await readTransactionBound(tx)
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'completed'
    })

    expect(applied).toBe(35000)
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

describeTransactional('transaction handle', function () {
  it('should settle once and refuse anything after', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const db = ctx.boss.getDb()
    const tx = await db.beginTransaction!()

    await tx.db.executeSql('SELECT 1')
    await tx.rollback()

    // idempotent: a second rollback must not send ROLLBACK down a connection the pool has since
    // handed to someone else
    await tx.rollback()

    await expect(async () => await tx.db.executeSql('SELECT 1')).rejects.toThrow(/already settled/)
    await expect(async () => await tx.commit()).rejects.toThrow(/already settled/)
  })
})

helper.describeMultiConnectionOnly('transaction handle (connection loss)', function () {
  it('should survive a connection dropped mid-transaction', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const db = ctx.boss.getDb()
    const tx = await db.beginTransaction!()

    const { rows } = await tx.db.executeSql('SELECT pg_backend_pid() AS pid')
    const other = await helper.getDb()

    try {
      await other.executeSql('SELECT pg_terminate_backend($1)', [rows[0].pid])
    } finally {
      await other.close()
    }

    // pg-pool takes its own 'error' listener off a checked-out client, so without one of its own
    // the handle would let this drop end the process instead of failing the transaction.
    await until(async () => {
      try {
        await tx.db.executeSql('SELECT 1')
        return false
      } catch {
        return true
      }
    })

    await tx.rollback()
  })

  it('should fail a transactional batch whose connection dies without a sqlstate', async function () {
    // What a database-side bound looks like from the driver when it arrives as a bare disconnect
    // rather than an error code: CockroachDB's idle_in_transaction_session_timeout reports no
    // SQLSTATE at all, so the handle has nothing to read the cause by and only the drop to go on.
    // pg_terminate_backend lands the same way.
    ctx.boss = await helper.start(ctx.bossConfig)

    const sideEffects = `${ctx.schema}.side_effect`
    const db = ctx.boss.getDb()

    await db.executeSql(`CREATE TABLE ${sideEffects} (note text)`)

    const jobId = await ctx.boss.send(ctx.schema, { work: true }, { retryLimit: 0 })
    helper.assertTruthy(jobId)

    await ctx.boss.work(ctx.schema, { transactional: true }, async (jobs, tx) => {
      await tx.executeSql(`INSERT INTO ${sideEffects} VALUES ('first-half')`)

      const { rows } = await tx.executeSql('SELECT pg_backend_pid() AS pid')
      const other = await helper.getDb()

      try {
        await other.executeSql('SELECT pg_terminate_backend($1)', [rows[0].pid])
      } finally {
        await other.close()
      }
    })

    await until(async () => {
      const job = await ctx.boss!.getJobById(ctx.schema, jobId)
      return job?.state === 'failed'
    })

    const { rows } = await db.executeSql(`SELECT note FROM ${sideEffects}`)
    expect(rows.length).toBe(0)

    // The shutdown has to finish too: a raw connection error escaping the settle path would take
    // the process with it rather than the batch.
    await ctx.boss.stop({ graceful: false })
    ctx.boss = undefined
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

  it('should reject a non-integer transactionTimeoutSeconds', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { transactional: true, transactionTimeoutSeconds: 1.5 } as any, async () => {})
    }).rejects.toThrow(/transactionTimeoutSeconds must be an integer >= 0/)
  })

  it('should reject transactionTimeoutSeconds without transactional', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { transactionTimeoutSeconds: 10 } as any, async () => {})
    }).rejects.toThrow(/transactionTimeoutSeconds requires transactional/)
  })

  it('should reject transactional combined with perJobResults', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.work(ctx.schema, { transactional: true, perJobResults: true }, async () => [])
    }).rejects.toThrow(/perJobResults/)
  })
})

// The two ways a pg-boss-owned transaction fails on a statement of its own rather than the
// caller's: the BEGIN that opens it, and the COMMIT that settles it. Both have to release the
// client with the error, so the pool discards a connection whose transaction state it cannot know
// instead of handing it to the next caller.
describeTransactional('transaction handle (settle failures)', function () {
  it('should release the connection when the transaction cannot be opened', async function () {
    const db = await helper.getDb()
    const pool = (db as any).pool
    const released: Array<Error | undefined> = []

    // A client that answers everything except BEGIN, which is how a connection that died while
    // idle in the pool behaves: the checkout succeeds, and the first statement is what finds out.
    const client = {
      query: async (text: string) => {
        if (text === 'BEGIN') throw new Error('connection is dead')
        return { rows: [] }
      },
      on: () => {},
      removeListener: () => {},
      release: (err?: Error) => released.push(err)
    }

    try {
      ;(db as any).pool = { connect: async () => client }

      await expect(async () => await db.beginTransaction()).rejects.toThrow('connection is dead')

      expect(released).toHaveLength(1)
      expect(released[0]).toBeInstanceOf(Error)
    } finally {
      ;(db as any).pool = pool
      await db.close()
    }
  })

  // A deferred constraint is the one thing that makes a COMMIT fail after every statement inside
  // the transaction succeeded. CockroachDB has neither temp tables nor deferrable unique
  // constraints without an experimental flag, hence postgres only.
  helper.itPostgresOnly('should reject and settle the handle when the commit fails', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const db = ctx.boss.getDb()
    const tx = await db.beginTransaction!()

    await tx.db.executeSql('CREATE TEMP TABLE commit_check (id int UNIQUE DEFERRABLE INITIALLY DEFERRED)')
    await tx.db.executeSql('INSERT INTO commit_check (id) VALUES (1), (1)')

    await expect(async () => await tx.commit()).rejects.toThrow(/duplicate key/)

    // Released with the error, so the handle is settled and the connection is gone with the
    // transaction it could not commit.
    await expect(async () => await tx.db.executeSql('SELECT 1')).rejects.toThrow(/already settled/)
  })
})
