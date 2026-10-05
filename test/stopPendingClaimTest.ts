import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { delay } from '../src/tools.ts'
import { PgBoss } from '../src/index.ts'
import pg from 'pg'

helper.describeMultiConnectionOnly('stopping during a PostgreSQL claim', function () {
  for (const configuration of [
    { name: 'metadata-enabled batch', options: { includeMetadata: true } },
    { name: 'metadata-free grouped batch', options: { includeMetadata: false, localGroupConcurrency: 1 } }
  ]) {
    it(`settles a pending ${configuration.name} after the grace without starting its handler`, async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const boss = ctx.boss
      const blocker = new pg.Client(helper.getConfig())
      await blocker.connect()
      const observer = await helper.getDb()
      const gateKey = 951
      let gateHeld = false
      let stopResolved = false
      let secondStopResolved = false
      let resolvedBeforeUnlock = false
      let secondResolvedBeforeUnlock = false
      let stateAtStop = 'not-stopped'
      let stopping = Promise.resolve()
      let secondStopping = Promise.resolve()
      let releaseGate = Promise.resolve()

      try {
        await observer.executeSql(`CREATE TABLE ${ctx.schema}.callback_receipts (
        job_id uuid PRIMARY KEY, after_stop boolean NOT NULL, signal_aborted boolean NOT NULL
      )`)
        await observer.executeSql(`CREATE FUNCTION ${ctx.schema}.hold_claim() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.state = 'created' AND NEW.state = 'active' THEN
            PERFORM pg_advisory_xact_lock(${gateKey});
          END IF;
          RETURN NEW;
        END $$`)
        await observer.executeSql(`CREATE TRIGGER hold_claim BEFORE UPDATE OF state ON ${ctx.schema}.job
        FOR EACH ROW EXECUTE FUNCTION ${ctx.schema}.hold_claim()`)
        await blocker.query('SELECT pg_advisory_lock($1)', [gateKey])
        gateHeld = true

        const jobId = await boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 120, group: { id: 'held-group' } })
        helper.assertTruthy(jobId)
        await boss.work(ctx.schema, configuration.options, async ([job]) => {
          await observer.executeSql(`INSERT INTO ${ctx.schema}.callback_receipts
          (job_id, after_stop, signal_aborted) VALUES ($1, $2, $3)`,
          [job.id, stopResolved, job.signal.aborted])
        })
        await helper.until(async () => {
          const { rows } = await observer.executeSql(`SELECT pid FROM pg_stat_activity
          WHERE wait_event = 'advisory' AND query LIKE $1`, [`%${ctx.schema}.%`])
          return rows.length > 0
        })

        stopping = boss.stop({ close: false, timeout: 1000 }).then(async () => {
          stopResolved = true
          const stoppedJob = await boss.getJobById(ctx.schema, jobId)
          helper.assertTruthy(stoppedJob)
          stateAtStop = stoppedJob.state
        })
        secondStopping = boss.stop({ close: false, timeout: 1000 }).then(() => { secondStopResolved = true })
        // Released after the 1s grace, so stop() has to wait for the claim beyond it.
        releaseGate = delay(2000).then(async () => {
          resolvedBeforeUnlock = stopResolved
          secondResolvedBeforeUnlock = secondStopResolved
          await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey])
          gateHeld = false
        })
        await releaseGate
        await Promise.all([stopping, secondStopping])
        await helper.until(async () => {
          const { rows } = await observer.executeSql(`SELECT job_id FROM ${ctx.schema}.callback_receipts`)
          const job = await boss.getJobById(ctx.schema, jobId)
          return rows.length > 0 || job?.state === 'failed'
        })
        const { rows } = await observer.executeSql(`SELECT after_stop, signal_aborted FROM ${ctx.schema}.callback_receipts`)
        const job = await boss.getJobById(ctx.schema, jobId)
        expect(rows).toEqual([])
        expect(resolvedBeforeUnlock).toBe(false)
        expect(secondResolvedBeforeUnlock).toBe(false)
        expect(job?.state).toBe('failed')
        expect(stateAtStop).toBe('failed')
        expect(boss.getWipData()).toEqual([])
        await expect(boss.getQueues()).resolves.toEqual(expect.any(Array))
      } finally {
        if (gateHeld) await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey])
        await releaseGate
        await Promise.all([stopping, secondStopping])
        // The pre-fix handler returns after its receipt, so baseline cleanup can finish too.
        await helper.until(() => boss.getWipData().length === 0)
        await Promise.all([blocker.end(), observer.close()])
      }
    }, 30_000)
  }

  // A claim landing while the grace is still running gets its handler, as on any graceful stop.
  for (const retryLimit of [0, 2]) {
    it(`runs a claim that lands inside the grace (retryLimit ${retryLimit})`, async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      const boss = ctx.boss
      const blocker = new pg.Client(helper.getConfig())
      await blocker.connect()
      const observer = await helper.getDb()
      const gateKey = 961
      let gateHeld = false

      try {
        await observer.executeSql(`CREATE FUNCTION ${ctx.schema}.hold_claim() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.state = 'created' AND NEW.state = 'active' THEN
            PERFORM pg_advisory_xact_lock(${gateKey});
          END IF;
          RETURN NEW;
        END $$`)
        await observer.executeSql(`CREATE TRIGGER hold_claim BEFORE UPDATE OF state ON ${ctx.schema}.job
        FOR EACH ROW EXECUTE FUNCTION ${ctx.schema}.hold_claim()`)
        await blocker.query('SELECT pg_advisory_lock($1)', [gateKey])
        gateHeld = true

        const jobId = await boss.send(ctx.schema, null, { retryLimit, retryDelay: 0 })
        helper.assertTruthy(jobId)
        let ran = false
        await boss.work(ctx.schema, async () => { ran = true })
        await helper.until(async () => {
          const { rows } = await observer.executeSql(`SELECT pid FROM pg_stat_activity
          WHERE wait_event = 'advisory' AND query LIKE $1`, [`%${ctx.schema}.%`])
          return rows.length > 0
        })

        // Held for 1s of a 10s grace.
        const stopping = boss.stop({ close: false, timeout: 10_000 })
        await delay(1000)
        await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey])
        gateHeld = false
        await stopping

        const job = await boss.getJobById(ctx.schema, jobId)
        expect(ran).toBe(true)
        expect(job?.state).toBe('completed')
        expect(job?.retryCount).toBe(0)
      } finally {
        if (gateHeld) await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey])
        await Promise.all([blocker.end(), observer.close()])
      }
    }, 30_000)
  }

  it('refuses a handler after transactional preparation and preserves a newer metadata-free claim', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const owner = ctx.boss
    const borrowed = await helper.getDb({ max: 4 })
    const blocker = new pg.Client(helper.getConfig())
    await blocker.connect()
    const observer = await helper.getDb()
    const gateKey = 952
    let gateHeld = false
    const boss = new PgBoss({
      ...ctx.bossConfig,
      createSchema: false,
      migrate: false,
      db: {
        executeSql: borrowed.executeSql.bind(borrowed),
        beginTransaction: async () => {
          const transaction = await borrowed.beginTransaction()
          await transaction.db.executeSql('SELECT pg_advisory_xact_lock($1)', [gateKey])
          return transaction
        }
      }
    })
    // Errors are expected while the stop refuses the claim; the assertions below are what matter.
    boss.on('error', () => {})
    let stopping = Promise.resolve()
    let releaseGate = Promise.resolve()
    let callbackEntered = false
    let callbackCompletion: Promise<unknown> | undefined

    try {
      await boss.start()
      await observer.executeSql(`CREATE TABLE ${ctx.schema}.callback_receipts (job_id uuid PRIMARY KEY)`)
      await blocker.query('SELECT pg_advisory_lock($1)', [gateKey])
      gateHeld = true
      const jobId = await boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 0, expireInSeconds: 120 })
      helper.assertTruthy(jobId)
      await boss.work(ctx.schema, { transactional: true }, ([job]) => {
        // Outside the handler transaction: a rollback must not erase evidence of late dispatch.
        callbackEntered = true
        callbackCompletion = observer.executeSql(`INSERT INTO ${ctx.schema}.callback_receipts (job_id) VALUES ($1)`, [job.id])
        return callbackCompletion
      })
      await helper.until(async () => {
        const { rows } = await observer.executeSql(`SELECT pid FROM pg_stat_activity
          WHERE wait_event = 'advisory' AND query = 'SELECT pg_advisory_xact_lock($1)'
            AND pg_blocking_pids(pid) <> '{}'`)
        return rows.length > 0
      })

      await owner.fail(ctx.schema, jobId, { message: 'the first attempt was reclaimed' })
      const [newer] = await owner.fetch(ctx.schema)
      helper.assertTruthy(newer)
      expect(newer.id).toBe(jobId)
      expect(newer.retryCount).toBe(1)

      stopping = boss.stop({ graceful: false })
      releaseGate = delay(1000).then(async () => {
        await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey])
        gateHeld = false
      })
      await releaseGate
      await stopping
      await helper.until(() => boss.getWipData().length === 0)
      await callbackCompletion
      const { rows } = await observer.executeSql(`SELECT job_id FROM ${ctx.schema}.callback_receipts`)
      const job = await owner.getJobById(ctx.schema, jobId)
      expect(callbackEntered).toBe(false)
      expect(rows).toEqual([])
      expect(job?.state).toBe('active')
      expect(job?.retryCount).toBe(newer.retryCount)
      await expect(borrowed.executeSql('SELECT 1 AS usable')).resolves.toMatchObject({ rows: [{ usable: 1 }] })
      await owner.fail(ctx.schema, newer)
    } finally {
      if (gateHeld) await blocker.query('SELECT pg_advisory_unlock($1)', [gateKey])
      await releaseGate
      await stopping
      await boss.stop({ graceful: false })
      await callbackCompletion
      await Promise.all([borrowed.close(), blocker.end(), observer.close()])
    }
  })
})
