import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import { PgBoss } from '../src/index.ts'
import { ctx } from './hooks.ts'

describe('ops', function () {
  it('should emit error in worker', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__throw_worker: true })

    await ctx.boss.send(ctx.schema)
    await ctx.boss.work(ctx.schema, async () => {})

    await new Promise(resolve => ctx.boss!.once('error', resolve))
  })

  it('should return null from getJobById if not found', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.getJobById(ctx.schema, randomUUID())

    expect(jobId).toBeFalsy()
  })

  it('should force stop', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop({ graceful: false })
  })

  it('should close the connection pool', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop({ graceful: false })

    // @ts-ignore
    expect(ctx.boss.getDb().pool.totalCount).toBe(0)
  })

  it('should close the connection pool gracefully', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop()

    // @ts-ignore
    expect(ctx.boss.getDb().pool.totalCount).toBe(0)
  })

  it('should not close the connection pool after stop with close option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop({ close: false })

    const jobId = await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(jobId).toBe(job.id)
  })

  it('should be able to run an arbitrary query via getDb()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const { rows } = await ctx.boss.getDb().executeSql('select 1')
    expect(rows.length).toBe(1)
  })

  it('should start and stop immediately', async function () {
    const boss = new PgBoss(ctx.bossConfig)
    await boss.start()
    await boss.stop()
  })

  it('should not leave open handles after starting and stopping', async function () {
    const resourcesBefore = process.getActiveResourcesInfo()

    const boss = new PgBoss({ ...ctx.bossConfig, supervise: true, schedule: true })
    await boss.start()
    await boss.createQueue(ctx.schema)
    await boss.work(ctx.schema, async () => {})
    await boss.stop()

    // Allow a tick for cleanup
    await new Promise(resolve => setImmediate(resolve))

    const resourcesAfter = process.getActiveResourcesInfo()

    // Check that resources didn't increase (no leaks)
    expect(resourcesAfter.length).toBeLessThanOrEqual(resourcesBefore.length)
  })
})
