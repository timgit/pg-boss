import { describe, it, expect, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PgBoss, fromPglite } from '../src/index.ts'

// End-to-end coverage against a real (in-memory) PGlite instance. PGlite is full PostgreSQL, so it
// runs with the `pglite` backend profile (no compatibility flags) and supports features the
// distributed backends cannot — including declarative table partitioning. Each test owns its own
// instance, so these are independent of the shared pg-backed test harness.
describe('pglite', () => {
  let instances: PGlite[] = []

  afterEach(async () => {
    await Promise.all(instances.map(i => i.close()))
    instances = []
  })

  async function startBoss (extra: Record<string, any> = {}) {
    const pglite = new PGlite()
    instances.push(pglite)
    const boss = new PgBoss({ backend: 'pglite', db: fromPglite(pglite), supervise: false, schedule: false, ...extra })
    boss.on('error', () => {})
    await boss.start()
    return boss
  }

  it('migrates the schema on start', async () => {
    const boss = await startBoss()
    expect(await boss.isInstalled()).toBe(true)
    expect(await boss.schemaVersion()).toBeGreaterThan(0)
    await boss.stop({ graceful: false })
  })

  it('sends, fetches, and completes a job', async () => {
    const boss = await startBoss()
    await boss.createQueue('email')

    const id = await boss.send('email', { to: 'a@b.com' })
    expect(id).toBeTruthy()

    const [job] = await boss.fetch('email')
    expect(job.id).toBe(id)
    expect(job.data).toEqual({ to: 'a@b.com' })

    await boss.complete('email', job.id)
    const [completed] = await boss.fetch('email')
    expect(completed).toBeUndefined()

    await boss.stop({ graceful: false })
  })

  it('retries a failed job', async () => {
    const boss = await startBoss()
    await boss.createQueue('retryable')

    const id = await boss.send('retryable', {}, { retryLimit: 1 })
    const [job] = await boss.fetch('retryable')
    await boss.fail('retryable', job.id)

    const [retried] = await boss.fetch('retryable')
    expect(retried.id).toBe(id)

    await boss.stop({ graceful: false })
  })

  it('supports partitioned queues (full PostgreSQL partitioning)', async () => {
    const boss = await startBoss()
    await boss.createQueue('partitioned', { partition: true } as any)

    const id = await boss.send('partitioned', { n: 1 })
    const [job] = await boss.fetch('partitioned')
    expect(job.id).toBe(id)

    await boss.stop({ graceful: false })
  })
})
