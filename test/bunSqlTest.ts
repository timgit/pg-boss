import { it, afterEach } from 'vitest'
import { SQL } from 'bun'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss, fromBunSql } from '../src/index.ts'

// Bun's SQL client speaks the wire protocol, so it needs a real server — skipped under PGlite.
const describe = helper.describePglite

// End-to-end coverage of fromBunSql against a real PostgreSQL server, in both of its shapes: as the
// connection for a whole pg-boss instance (replacing the default pg pool) and as a per-operation
// handle inside a sql.begin() transaction. This is where the workarounds the adapter carries for
// bun's parameter binding are actually proven — the unit tests in bunAdapterTest.ts only assert the
// shape of what gets sent.
describe('bun sql', () => {
  let clients: SQL[] = []

  afterEach(async () => {
    await Promise.all(clients.map(client => client.close()))
    clients = []
  })

  function getSql (): SQL {
    const client = new SQL(helper.getConnectionString(), { max: 5 })
    clients.push(client)
    return client
  }

  async function startBoss (sql: SQL): Promise<PgBoss> {
    const boss = new PgBoss({ ...ctx.bossConfig, db: fromBunSql(sql) })
    boss.on('error', () => {})
    await boss.start()
    ctx.boss = boss
    return boss
  }

  it('installs the schema on start', async () => {
    // The decisive case for the reserved-connection path: contractor wraps its DDL in a
    // BEGIN ... COMMIT block, which bun refuses to run on a pooled connection.
    const boss = await startBoss(getSql())

    expect(await boss.isInstalled()).toBe(true)
    expect(await boss.schemaVersion()).toBeGreaterThan(0)
  })

  it('sends, fetches, and completes a job', async () => {
    // Covers the json parameter path end to end: send binds an encoded payload to
    // json_to_recordset($1::json), complete binds a live object to $3::jsonb.
    const boss = await startBoss(getSql())
    await boss.createQueue('email')

    const id = await boss.send('email', { to: 'a@b.com', attempts: 1 })
    expect(id).toBeTruthy()

    const [job] = await boss.fetch('email')
    expect(job.id).toBe(id)
    expect(job.data).toEqual({ to: 'a@b.com', attempts: 1 })

    await boss.complete('email', job.id, { delivered: true })

    const completed = await boss.getJobById('email', id!)
    helper.assertTruthy(completed)
    expect(completed.state).toBe('completed')
    expect(completed.output).toEqual({ delivered: true })
  })

  it('round-trips a job whose data is an array', async () => {
    // An array value is a postgres array everywhere except behind a json cast, where it has to be
    // encoded as a json document instead.
    const boss = await startBoss(getSql())
    await boss.createQueue('arrays')

    const id = await boss.send('arrays', [1, 'two', { three: true }] as any)
    const job = await boss.getJobById('arrays', id!)

    helper.assertTruthy(job)
    expect(job.data).toEqual([1, 'two', { three: true }])
  })

  it('fails a job and captures the serialized error output', async () => {
    const boss = await startBoss(getSql())
    await boss.createQueue('failures')

    const id = await boss.send('failures', {}, { retryLimit: 0 })
    const [job] = await boss.fetch('failures')
    await boss.fail('failures', job.id, new Error('boom'))

    const failed = await boss.getJobById('failures', id!)
    helper.assertTruthy(failed)
    expect(failed.state).toBe('failed')
    expect((failed.output as any).message).toBe('boom')
  })

  it('cancels jobs by id, binding a uuid array parameter', async () => {
    // cancel() filters on `id = ANY($2::uuid[])`, which bun cannot bind from a JS array.
    const boss = await startBoss(getSql())
    await boss.createQueue('cancellable')

    const first = await boss.send('cancellable', {})
    const second = await boss.send('cancellable', {})

    const result = await boss.cancel('cancellable', [first!, second!])
    expect(result.affected).toBe(2)

    const job = await boss.getJobById('cancellable', first!)
    helper.assertTruthy(job)
    expect(job.state).toBe('cancelled')
  })

  it('filters queues by name, binding a text array parameter', async () => {
    const boss = await startBoss(getSql())
    await boss.createQueue('wanted')
    await boss.createQueue('unwanted')

    const queues = await boss.getQueues(['wanted'])
    expect(queues.map(queue => queue.name)).toEqual(['wanted'])
  })

  it('runs maintenance, which issues advisory-locked transaction blocks', async () => {
    const boss = await startBoss(getSql())
    await boss.createQueue('maintained')
    await boss.send('maintained', {})

    await boss.supervise()

    const [stats] = await boss.getQueueStats('maintained')
    expect(stats.queuedCount).toBe(1)
  })

  it('inserts a batch of jobs', async () => {
    const boss = await startBoss(getSql())
    await boss.createQueue('batched')

    await boss.insert('batched', [{ data: { n: 1 } }, { data: { n: 2 } }])

    const jobs = await boss.fetch('batched', { batchSize: 2 })
    expect(jobs.length).toBe(2)
  })

  it('creates a job inside a bun transaction', async () => {
    const sql = getSql()
    const boss = await startBoss(sql)
    await boss.createQueue('transactional')

    const id = await sql.begin(async (tx: any) =>
      boss.send('transactional', { committed: true }, { db: fromBunSql(tx) }))

    const job = await boss.getJobById('transactional', id as string)
    helper.assertTruthy(job)
    expect(job.data).toEqual({ committed: true })
  })

  it('discards a job when the bun transaction rolls back', async () => {
    const sql = getSql()
    const boss = await startBoss(sql)
    await boss.createQueue('rollbacks')

    let id: string | null = null

    try {
      await sql.begin(async (tx: any) => {
        id = await boss.send('rollbacks', { committed: false }, { db: fromBunSql(tx) })
        throw new Error('force rollback')
      })
    } catch {}

    expect(id).toBeTruthy()
    expect(await boss.getJobById('rollbacks', id!)).toBeNull()
  })

  it('falls back to polling when useListenNotify is enabled', async () => {
    // Bun implements neither LISTEN nor NOTIFY, so the notifier must warn and keep polling rather
    // than fail start(). The pg_notify pg-boss inlines into inserts is evaluated by postgres and
    // still fires, so a queue can stay opted in.
    const warnings: any[] = []
    const boss = new PgBoss({ ...ctx.bossConfig, db: fromBunSql(getSql()), useListenNotify: true })
    boss.on('error', () => {})
    boss.on('warning', warning => warnings.push(warning))

    await boss.start()
    ctx.boss = boss

    await boss.createQueue('notified', { notify: true } as any)
    const id = await boss.send('notified', {})

    expect(warnings.some(warning => warning.data?.type === 'listen_notify_unavailable')).toBe(true)

    const [job] = await helper.fetchWithRetry(boss, 'notified')
    expect(job.id).toBe(id)
  })
})
