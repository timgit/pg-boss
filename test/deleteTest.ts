import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'
import Boss from '../src/boss.ts'
import Manager from '../src/manager.ts'
import * as Attorney from '../src/attorney.ts'
import type { IDatabase } from '../src/types.ts'

describe('delete', function () {
  it('should delete a completed job via maintenance', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1
    }

    ctx.boss = await helper.start(config)

    const jobId = await ctx.boss.send(ctx.schema, null, { deleteAfterSeconds: 1 })

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(1000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should delete a completed job via maintenance - cascade config from queue', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.createQueue(ctx.schema, { deleteAfterSeconds: 1 })

    const jobId = await ctx.boss.send(ctx.schema)
    expect(jobId).toBeTruthy()
    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(1000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should delete a job via deleteJob()', async function () {
    const config = { ...ctx.bossConfig }
    ctx.boss = await helper.start(config)

    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)

    assertTruthy(jobId)
    await ctx.boss.deleteJob(ctx.schema, jobId)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeFalsy()
  })

  it('should delete every expired job when the sweep spans several batches', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1,
      __test__walk_batch_size: 2
    }

    ctx.boss = await helper.start(config)

    const expiring = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.boss!.send(ctx.schema, null, { deleteAfterSeconds: 1 })))
    const retained = await Promise.all([1, 2].map(() => ctx.boss!.send(ctx.schema, null, { deleteAfterSeconds: 0 })))

    const fetched = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(fetched.length).toBe(7)
    await ctx.boss.complete(ctx.schema, fetched.map(job => job.id))

    const queued = await ctx.boss.send(ctx.schema)

    await delay(1000)

    await ctx.boss.supervise(ctx.schema)

    for (const id of expiring) {
      assertTruthy(id)
      expect(await ctx.boss.getJobById(ctx.schema, id)).toBeFalsy()
    }

    for (const id of [...retained, queued]) {
      assertTruthy(id)
      expect(await ctx.boss.getJobById(ctx.schema, id)).toBeTruthy()
    }
  })

  // Driven through Boss itself, whose stop() raises its stopping flag before its first await, so the
  // flag is up when the first batch returns. PgBoss.stop() stops other components first.
  it('should leave the rest of a queue for the next pass when stop() lands between deletion batches', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })
    await Promise.all([1, 2, 3, 4, 5].map(() => ctx.boss!.send(ctx.schema)))
    const queue = await ctx.boss.getQueue(ctx.schema)
    assertTruthy(queue)

    const db = await helper.getDb()
    const config = Attorney.getConfig({ ...ctx.bossConfig, supervise: false, __test__walk_batch_size: 2 })
    let batches = 0

    const stopAfterFirstBatch: IDatabase = {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await db.executeSql(text, values)
        if (text.includes('"walkCursor"') && ++batches === 1) boss.stop()
        return result
      }
    }

    const boss = new Boss(stopAfterFirstBatch, new Manager(stopAfterFirstBatch, config), config)
    await boss.start()
    await boss.supervise([queue])

    // One batch of three, and a walk that did not cover the queue records no retained count.
    expect(batches).toBe(1)
    const { rows } = await db.executeSql(`SELECT retained_count FROM ${ctx.schema}.queue WHERE name = $1`, [ctx.schema])
    expect(rows[0].retained_count).toBeNull()

    if (!helper.isPglite) await db.close()
  })

  it('should never delete a completed job when deleteAfterSeconds is 0', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1
    }

    ctx.boss = await helper.start(config)

    const jobId = await ctx.boss.send(ctx.schema, null, { deleteAfterSeconds: 0 })

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(2000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeTruthy()
    expect(job?.state).toBe('completed')
  })

  it('should never delete a completed job when deleteAfterSeconds is 0 - cascade config from queue', async function () {
    const config = {
      ...ctx.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.createQueue(ctx.schema, { deleteAfterSeconds: 0 })

    const jobId = await ctx.boss.send(ctx.schema)
    expect(jobId).toBeTruthy()
    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.complete(ctx.schema, jobId)

    await delay(2000)

    await ctx.boss.supervise(ctx.schema)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job).toBeTruthy()
    expect(job?.state).toBe('completed')
  })
})
