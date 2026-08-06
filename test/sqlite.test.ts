import { describe, it, expect, afterEach } from './harness.ts'
import { SQL } from 'bun'
import { BunBoss, fromBunSqlite } from '../src/index.ts'
import { delay } from '../src/tools.ts'
import packageJson from '../package.json' with { type: 'json' }

// End-to-end coverage against a real in-memory SQLite database through Bun's SQL client. SQLite is
// a different SQL dialect (not a Postgres-compatible engine), so the `sqlite` backend profile sets
// every compatibility flag and plans.ts renders its sqlite branches. Each test owns its own
// instance, so these are independent of the shared test harness.
describe('sqlite', () => {
  let instances: SQL[] = []

  afterEach(async () => {
    await Promise.all(instances.map(i => i.close()))
    instances = []
  })

  function newInstance () {
    const sql = new SQL('sqlite://:memory:')
    instances.push(sql)
    return sql
  }

  async function startBoss (extra: Record<string, any> = {}) {
    const boss = new BunBoss({ backend: 'sqlite', db: fromBunSqlite(newInstance()), supervise: false, schedule: false, ...extra })
    boss.on('error', () => {})
    await boss.start()
    return boss
  }

  it('installs the schema on start', async () => {
    const boss = await startBoss()
    expect(await boss.isInstalled()).toBe(true)
    expect(await boss.schemaVersion()).toBe(packageJson.bunboss.schema)
    await boss.stop({ graceful: false })
  })

  it('refuses to start against an older installed schema version', async () => {
    const sql = newInstance()
    const first = new BunBoss({ backend: 'sqlite', db: fromBunSqlite(sql), supervise: false, schedule: false })
    first.on('error', () => {})
    await first.start()
    await first.stop({ graceful: false })

    await sql.unsafe(`UPDATE "pgboss.version" SET version = ${packageJson.bunboss.schema - 1}`)

    const second = new BunBoss({ backend: 'sqlite', db: fromBunSqlite(sql), supervise: false, schedule: false })
    second.on('error', () => {})
    await expect(second.start()).rejects.toThrow(/cannot be upgraded/)
  })

  it('rejects a config without a db adapter', () => {
    expect(() => new BunBoss({ backend: 'sqlite' } as any)).toThrow(/requires a db adapter/)
  })

  it('rejects a config with a connection string', () => {
    expect(() => new BunBoss({ backend: 'sqlite', db: fromBunSqlite(newInstance()), connectionString: 'postgres://localhost/x' } as any)).toThrow(/connectionString/)
  })

  it('installs with a quoted schema name', async () => {
    const boss = new BunBoss({ backend: 'sqlite', db: fromBunSqlite(newInstance()), schema: '"MyBoss"', supervise: false, schedule: false })
    boss.on('error', () => {})
    await boss.start()

    expect(await boss.isInstalled()).toBe(true)

    await boss.createQueue('quoted')
    const id = await boss.send('quoted', { n: 1 })
    const [job] = await boss.fetch('quoted')
    expect(job.id).toBe(id!)

    await boss.stop({ graceful: false })
  })

  it('restarting against an installed database is a no-op', async () => {
    const sql = newInstance()
    const first = new BunBoss({ backend: 'sqlite', db: fromBunSqlite(sql), supervise: false, schedule: false })
    first.on('error', () => {})
    await first.start()
    await first.stop({ graceful: false })

    const second = new BunBoss({ backend: 'sqlite', db: fromBunSqlite(sql), supervise: false, schedule: false })
    second.on('error', () => {})
    await second.start()
    expect(await second.isInstalled()).toBe(true)
    await second.stop({ graceful: false })
  })

  it('creates, reads, updates, and deletes queues', async () => {
    const boss = await startBoss()

    await boss.createQueue('orders', { retryLimit: 3 })
    const queue = await boss.getQueue('orders')

    expect(queue).toBeTruthy()
    expect(queue!.name).toBe('orders')
    expect(queue!.policy).toBe('standard')
    expect(queue!.retryLimit).toBe(3)
    expect(queue!.retryBackoff).toBe(false)
    expect(queue!.createdOn).toBeInstanceOf(Date)

    await boss.updateQueue('orders', { retryLimit: 5, retryBackoff: true, retryDelayMax: 60 })
    const updated = await boss.getQueue('orders')

    expect(updated!.retryLimit).toBe(5)
    expect(updated!.retryBackoff).toBe(true)
    expect(updated!.retryDelayMax).toBe(60)

    await boss.deleteQueue('orders')
    expect(await boss.getQueue('orders')).toBeNull()

    await boss.stop({ graceful: false })
  })

  it('creating an existing queue is a no-op', async () => {
    const boss = await startBoss()

    await boss.createQueue('dupes', { retryLimit: 3 })
    await boss.createQueue('dupes', { retryLimit: 9 })

    const queue = await boss.getQueue('dupes')
    expect(queue!.retryLimit).toBe(3)

    await boss.stop({ graceful: false })
  })

  it('sends, fetches, and completes a job', async () => {
    const boss = await startBoss()
    await boss.createQueue('email')

    const id = await boss.send('email', { to: 'a@b.com', note: 'has "quotes" inside' })
    expect(id).toBeTruthy()

    const [job] = await boss.fetch('email')
    expect(job.id).toBe(id!)
    expect(job.data).toEqual({ to: 'a@b.com', note: 'has "quotes" inside' })

    await boss.complete('email', job.id)
    const [completed] = await boss.fetch('email')
    expect(completed).toBeUndefined()

    await boss.stop({ graceful: false })
  })

  it('returns typed metadata on fetch', async () => {
    const boss = await startBoss()
    await boss.createQueue('meta')

    await boss.send('meta', { n: 1 })
    const [job] = await boss.fetch('meta', { includeMetadata: true })

    expect(job.state).toBe('active')
    expect(job.retryLimit).toBe(2)
    expect(job.retryBackoff).toBe(false)
    expect(job.createdOn).toBeInstanceOf(Date)
    expect(job.startAfter).toBeInstanceOf(Date)
    expect(job.startedOn).toBeInstanceOf(Date)
    expect(job.keepUntil).toBeInstanceOf(Date)
    expect(job.keepUntil.getTime()).toBeGreaterThan(Date.now())

    await boss.stop({ graceful: false })
  })

  it('defers a job sent with a relative interval string', async () => {
    const boss = await startBoss()
    await boss.createQueue('later')

    await boss.send('later', {}, { startAfter: '5 minutes' })

    const [job] = await boss.fetch('later')
    expect(job).toBeUndefined()

    const [row] = await boss.findJobs('later', { queued: true })
    expect(row.startAfter.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000)

    await boss.stop({ graceful: false })
  })

  it('fetches jobs in priority then insertion order', async () => {
    const boss = await startBoss()
    await boss.createQueue('ordered')

    // Distinct created_on per send: sqlite timestamps have millisecond resolution, and same-ms
    // rows tie-break on random uuid order (same as the pglite harness accommodation).
    await boss.send('ordered', { pos: 'second' })
    await delay(2)
    await boss.send('ordered', { pos: 'third' })
    await delay(2)
    await boss.send('ordered', { pos: 'first' }, { priority: 5 })

    const jobs = await boss.fetch('ordered', { batchSize: 3 })
    expect(jobs.map(j => (j.data as any).pos)).toEqual(['first', 'second', 'third'])

    await boss.stop({ graceful: false })
  })

  it('retries a failed job', async () => {
    const boss = await startBoss()
    await boss.createQueue('retryable')

    const id = await boss.send('retryable', {}, { retryLimit: 1 })
    const [job] = await boss.fetch('retryable')
    await boss.fail('retryable', job.id)

    const [retried] = await boss.fetch('retryable')
    expect(retried.id).toBe(id!)

    await boss.stop({ graceful: false })
  })

  it('enforces the short policy singleton constraint', async () => {
    const boss = await startBoss()
    await boss.createQueue('once', { policy: 'short' } as any)

    const first = await boss.send('once', {}, { singletonKey: 'k1' })
    const second = await boss.send('once', {}, { singletonKey: 'k1' })

    expect(first).toBeTruthy()
    expect(second).toBeNull()

    await boss.stop({ graceful: false })
  })

  it('rolls back the whole flow when a queue policy skips a job', async () => {
    const boss = await startBoss()
    await boss.createQueue('flowq', { policy: 'short' } as any)

    // Occupy the singleton slot so the flow parent conflicts and the insert is skipped.
    await boss.send('flowq', {}, { singletonKey: 'k1' })

    await expect(boss.flow([
      { ref: 'parent', name: 'flowq', options: { singletonKey: 'k1' } },
      { ref: 'child', name: 'flowq', options: { singletonKey: 'other' }, dependsOn: ['parent'] }
    ])).rejects.toThrow(/could not be created/)

    // Atomic rollback: the child must not exist either.
    const jobs = await boss.findJobs('flowq', { queued: true })
    expect(jobs.length).toBe(1)

    await boss.stop({ graceful: false })
  })

  it('inserts a batch of jobs', async () => {
    const boss = await startBoss()
    await boss.createQueue('batch')

    await boss.insert('batch', [{ data: { n: 1 } }, { data: { n: 2 }, priority: 1 }, { id: crypto.randomUUID(), data: { n: 3 } }])

    const jobs = await boss.fetch('batch', { batchSize: 5 })
    expect(jobs.length).toBe(3)

    await boss.stop({ graceful: false })
  })
})
