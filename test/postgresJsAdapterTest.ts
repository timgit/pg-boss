import { it, afterAll } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import postgres from 'postgres'
import { PgBoss } from '../src/index.ts'
import { delay } from '../src/tools.ts'
import { fromPostgresJs } from '../src/adapters/index.ts'

// Drives pg-boss through a real postgres.js client. PGlite has no server to connect to.
const describe = helper.describePglite

describe('postgres.js adapter', () => {
  const client = postgres(helper.getConnectionString(), { max: 5, onnotice: () => {} })

  afterAll(async () => {
    await client.end()
  })

  async function start (options = {}) {
    const boss = new PgBoss({ ...ctx.bossConfig, ...options, db: fromPostgresJs(client) })
    const errors: Error[] = []
    boss.on('error', err => errors.push(err))
    await boss.start()
    ctx.boss = boss
    return { boss, errors }
  }

  it('refuses a transaction script on a pooled connection without the adapter', async () => {
    await expect(client.unsafe('BEGIN; SELECT 1; COMMIT;')).rejects.toMatchObject({ code: 'UNSAFE_TRANSACTION' })
  })

  it('rolls back a transaction script that fails, so its connection goes back to the pool clean', async () => {
    // one connection, so the statement after the failure lands on the session the script left
    const single = postgres(helper.getConnectionString(), { max: 1, onnotice: () => {} })
    const db = fromPostgresJs(single)

    try {
      await expect(db.executeSql('BEGIN; SELECT 1/0; COMMIT;')).rejects.toMatchObject({ code: '22012' })
      expect((await db.executeSql('SELECT 1::int4 AS one')).rows).toEqual([{ one: 1 }])
    } finally {
      await single.end()
    }
  })

  it('installs and maintains its schema through a reserved connection', async () => {
    // start() and supervise() both run BEGIN/COMMIT scripts, which the pool refuses
    const { boss, errors } = await start()

    await boss.supervise()

    const [{ version }] = await client.unsafe(`SELECT version FROM ${ctx.schema}.version`)
    expect(Number(version)).toBeGreaterThan(0)
    expect(errors.map(err => err.message)).toEqual([])
  })

  it('runs jobs through send, fetch, complete, fail, cancel and delete', async () => {
    const { boss } = await start()
    const queue = 'lifecycle'
    await boss.createQueue(queue)

    // complete() binds the id list as `= ANY($N::uuid[])`, which postgres.js encodes whole
    const ids = [await boss.send(queue, { n: 1 }), await boss.send(queue, { n: 2 })] as string[]
    const fetched = await boss.fetch(queue, { batchSize: 2 })
    expect(fetched.map(job => job.id).sort()).toEqual([...ids].sort())
    expect((await boss.complete(queue, ids, { done: true })).affected).toBe(2)
    expect((await boss.getJobById(queue, ids[0]!))!.output).toEqual({ done: true })

    const failed = await boss.send(queue, {}) as string
    await boss.fetch(queue)
    expect((await boss.fail(queue, failed, new Error('nope'))).affected).toBe(1)

    const cancelled = await boss.send(queue, {}) as string
    expect((await boss.cancel(queue, cancelled)).affected).toBe(1)

    const deleted = await boss.send(queue, {}) as string
    expect((await boss.deleteJob(queue, deleted)).affected).toBe(1)
  })

  it('binds objects and data filters to their json casts', async () => {
    const { boss } = await start()
    const queue = 'json'
    await boss.createQueue(queue)

    await boss.updateQueue(queue, { retryLimit: 7 })
    expect((await boss.getQueue(queue))!.retryLimit).toBe(7)

    await boss.insert(queue, [{ data: { kind: 'a' } }, { data: { kind: 'b' } }])
    const found = await boss.findJobs(queue, { data: { kind: 'a' } })
    expect(found.map(job => job.data)).toEqual([{ kind: 'a' }])
  })

  it('sends a job inside a postgres.js transaction, which a rollback discards', async () => {
    const { boss } = await start()
    const queue = 'transactional'
    await boss.createQueue(queue)

    const kept = await client.begin(tx => boss.send(queue, { n: 1 }, { db: fromPostgresJs(tx) }))

    let discarded: string | null = null
    await expect(client.begin(async tx => {
      discarded = await boss.send(queue, { n: 2 }, { db: fromPostgresJs(tx) })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    expect(await boss.getJobById(queue, kept!)).toBeTruthy()
    expect(discarded).toBeTruthy()
    expect(await boss.getJobById(queue, discarded!)).toBeNull()
  })

  it('binds an undefined value as null, as node-postgres does', async () => {
    const { boss } = await start()
    const queue = 'scheduled'
    await boss.createQueue(queue)

    // no data leaves its parameter undefined, which postgres.js refuses with UNDEFINED_VALUE
    await boss.schedule(queue, '* * * * *')

    expect((await boss.getSchedules(queue))[0]!.data).toBeNull()
  })

  it('delivers a job to a worker', async () => {
    const { boss } = await start()
    const queue = 'worked'
    await boss.createQueue(queue)

    const { promise, resolve } = Promise.withResolvers<unknown>()
    await boss.work(queue, async ([job]) => resolve(job!.data))
    await boss.send(queue, { via: 'worker' })

    expect(await promise).toEqual({ via: 'worker' })
  })

  it('commits a transactional worker\'s writes with its job, and rolls them back with a failure', async () => {
    const { boss } = await start()
    const queue = 'transactional_worker'
    await boss.createQueue(queue)
    await client.unsafe(`CREATE TABLE ${ctx.schema}.side_effect (note text)`)

    const kept = await boss.send(queue, { note: 'kept' }, { retryLimit: 0 })
    const dropped = await boss.send(queue, { note: 'dropped' }, { retryLimit: 0 })

    await boss.work(queue, { transactional: true }, async ([job], tx) => {
      const { note } = job!.data as { note: string }
      await tx.executeSql(`INSERT INTO ${ctx.schema}.side_effect VALUES ($1)`, [note])
      if (note === 'dropped') throw new Error('handler failed')
    })

    await helper.until(async () => {
      const states = await Promise.all([kept, dropped].map(async id => (await boss.getJobById(queue, id!))?.state))
      return states[0] === 'completed' && states[1] === 'failed'
    })

    const notes = await client.unsafe(`SELECT note FROM ${ctx.schema}.side_effect`)
    expect(notes.map(row => row.note)).toEqual(['kept'])
  })

  // CockroachDB's transaction_timeout aborts the transaction but keeps the connection
  helper.itPostgresOnly('refuses statements on a transaction the server ended, and rejects its commit', async () => {
    const db = fromPostgresJs(client)
    const tx = await db.beginTransaction!()

    // transaction_timeout arrived in PostgreSQL 17; on an older server there is nothing to end it
    const { rows: [{ guc }] } = await tx.db.executeSql("SELECT current_setting('transaction_timeout', true) AS guc")
    if (guc === null) return tx.rollback()

    await tx.db.executeSql('SET LOCAL transaction_timeout = 200')
    await delay(400)

    // a statement sent down the dropped connection would never settle, or crash postgres.js
    await expect(tx.db.executeSql('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    await expect(tx.db.executeSql('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    await expect(tx.commit()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })

    expect((await db.executeSql('SELECT 1::int4 AS one')).rows).toEqual([{ one: 1 }])
  })

  helper.itListenNotify('delivers a job through LISTEN/NOTIFY', async () => {
    const { boss } = await start({ useListenNotify: true })
    const queue = 'notified'
    await boss.createQueue(queue, { notify: true })

    const { promise, resolve } = Promise.withResolvers<unknown>()
    // Both polling intervals are well past the test's patience, so a delivery can only have come
    // from the NOTIFY.
    const poll = { pollingIntervalSeconds: 30, notifyPollingIntervalSeconds: 30 }
    await boss.work(queue, poll, async ([job]) => resolve(job!.data))
    await boss.send(queue, { woken: 'by notify' })

    expect(await promise).toEqual({ woken: 'by notify' })
  })

  it('surfaces a SQLSTATE where pg-boss reads it', async () => {
    const { boss } = await start()
    const queue = 'duplicated'
    await boss.createQueue(queue)

    // the in-SQL insert guard raises 22012 when a flow's jobs collide, which pg-boss translates
    // only if the state reached `code`
    const id = crypto.randomUUID()

    await expect(boss.flow([
      { ref: 'parent', name: queue, options: { id } },
      { ref: 'child', name: queue, options: { id }, dependsOn: ['parent'] }
    ])).rejects.toThrow('one or more jobs could not be created')
  })
})
