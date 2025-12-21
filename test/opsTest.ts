import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import { PgBoss } from '../src/index.ts'
import { testContext } from './hooks.ts'

describe('ops', function () {
  it('should emit error in worker', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__throw_worker: true })

    await testContext.boss.send(testContext.schema)
    await testContext.boss.work(testContext.schema, async () => {})

    await new Promise(resolve => testContext.boss!.once('error', resolve))
  })

  it('should return null from getJobById if not found', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.getJobById(testContext.schema, randomUUID())

    assert(!jobId)
  })

  it('should force stop', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop({ graceful: false })
  })

  it('should close the connection pool', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop({ graceful: false })

    // @ts-ignore
    assert(testContext.boss.getDb().pool.totalCount === 0)
  })

  it('should close the connection pool gracefully', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop()

    // @ts-ignore
    assert(testContext.boss.getDb().pool.totalCount === 0)
  })

  it('should not close the connection pool after stop with close option', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop({ close: false })

    const jobId = await testContext.boss.send(testContext.schema)
    const [job] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(jobId, job.id)
  })

  it('should be able to run an arbitrary query via getDb()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const { rows } = await testContext.boss.getDb().executeSql('select 1')
    assert.strictEqual(1, rows.length)
  })

  it('should start and stop immediately', async function () {
    const boss = new PgBoss(testContext.bossConfig)
    await boss.start()
    await boss.stop()
  })

  it('should not leave open handles after starting and stopping', async function () {
    const resourcesBefore = process.getActiveResourcesInfo()

    const boss = new PgBoss({ ...testContext.bossConfig, supervise: true, schedule: true })
    await boss.start()
    await boss.createQueue(testContext.schema)
    await boss.work(testContext.schema, async () => {})
    await boss.stop()

    // Allow a tick for cleanup
    await new Promise(resolve => setImmediate(resolve))

    const resourcesAfter = process.getActiveResourcesInfo()

    // Check that resources didn't increase (no leaks)
    assert(resourcesAfter.length <= resourcesBefore.length, `Should not leave open async resources. Before: ${resourcesBefore.length}, After: ${resourcesAfter.length}`)
  })
})
