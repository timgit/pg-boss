import { expect } from 'vitest'
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

    expect(jobId).toBeFalsy()
  })

  it('should force stop', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop({ graceful: false })
  })

  it('should close the connection pool', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop({ graceful: false })

    // @ts-ignore
    expect(testContext.boss.getDb().pool.totalCount).toBe(0)
  })

  it('should close the connection pool gracefully', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop()

    // @ts-ignore
    expect(testContext.boss.getDb().pool.totalCount).toBe(0)
  })

  it('should not close the connection pool after stop with close option', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.stop({ close: false })

    const jobId = await testContext.boss.send(testContext.schema)
    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(jobId).toBe(job.id)
  })

  it('should be able to run an arbitrary query via getDb()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const { rows } = await testContext.boss.getDb().executeSql('select 1')
    expect(rows.length).toBe(1)
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
    expect(resourcesAfter.length).toBeLessThanOrEqual(resourcesBefore.length)
  })
})
