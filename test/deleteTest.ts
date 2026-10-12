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

  // The claim stamps every queue before the first walk, so the queues a stopped pass did not finish
  // are handed back and come due on the next pass instead of a whole maintenance interval later.
  it('should hand back the maintenance claim on the queues a stopped pass did not finish', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, noDefault: true })
    const names = [`${ctx.schema}_a`, `${ctx.schema}_b`, `${ctx.schema}_c`]

    for (const name of names) {
      await ctx.boss.createQueue(name)
      await Promise.all([1, 2, 3].map(() => ctx.boss!.send(name)))
    }

    const queues = await ctx.boss.getQueues(names)
    const db = await helper.getDb()
    const config = Attorney.getConfig({ ...ctx.bossConfig, supervise: false, __test__walk_batch_size: 2 })
    let batches = 0

    // The first queue's walk takes two batches, and the stop lands in the second queue's first.
    const stopInSecondQueue: IDatabase = {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await db.executeSql(text, values)
        if (text.includes('"walkCursor"') && text.includes('"deletedRetained"') && ++batches === 3) boss.stop()
        return result
      }
    }

    const boss = new Boss(stopInSecondQueue, new Manager(stopInSecondQueue, config), config)
    await boss.start()
    await boss.supervise(queues)

    const { rows } = await db.executeSql(`SELECT name, maintain_on IS NOT NULL AS claimed FROM ${ctx.schema}.queue WHERE name = ANY($1::text[]) ORDER BY name`, [names])
    expect(rows).toEqual([
      { name: names[0], claimed: true },
      { name: names[1], claimed: false },
      { name: names[2], claimed: false }
    ])

    if (!helper.isPglite) await db.close()
  })

  // A pass that outlasts the maintenance interval may find a queue claimed again by another instance,
  // and handing back its own claim must not clear that one.
  it('should leave a claim another instance took since in place when a stopped pass hands back its own', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, noDefault: true })
    const names = [`${ctx.schema}_a`, `${ctx.schema}_b`, `${ctx.schema}_c`]

    for (const name of names) {
      await ctx.boss.createQueue(name)
      await Promise.all([1, 2, 3].map(() => ctx.boss!.send(name)))
    }

    const queues = await ctx.boss.getQueues(names)
    const db = await helper.getDb()
    const config = Attorney.getConfig({ ...ctx.bossConfig, supervise: false, __test__walk_batch_size: 2 })
    let batches = 0

    const stopInSecondQueue: IDatabase = {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await db.executeSql(text, values)
        if (text.includes('"walkCursor"') && text.includes('"deletedRetained"') && ++batches === 3) {
          await db.executeSql(`UPDATE ${ctx.schema}.queue SET maintain_on = maintain_on + interval '1 second' WHERE name = $1`, [names[2]])
          boss.stop()
        }
        return result
      }
    }

    const boss = new Boss(stopInSecondQueue, new Manager(stopInSecondQueue, config), config)
    await boss.start()
    await boss.supervise(queues)

    const { rows } = await db.executeSql(`SELECT name, maintain_on IS NOT NULL AS claimed FROM ${ctx.schema}.queue WHERE name = ANY($1::text[]) ORDER BY name`, [names])
    expect(rows).toEqual([
      { name: names[0], claimed: true },
      { name: names[1], claimed: false },
      { name: names[2], claimed: true }
    ])

    if (!helper.isPglite) await db.close()
  })

  // A failed walk hands the claims back the same way. A release that fails too is reported, and the
  // walk's own failure is what the pass rejects with.
  // A custom db that returns only the last statement's rows loses the batch's result row behind the
  // transaction's COMMIT. Taking that as the end of the queue would record a count of one batch.
  it('should fail a walk whose batch returns no result row instead of counting it done', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })
    await ctx.boss.send(ctx.schema)
    const queue = await ctx.boss.getQueue(ctx.schema)
    assertTruthy(queue)

    const db = await helper.getDb()
    const config = Attorney.getConfig({ ...ctx.bossConfig, supervise: false })

    const lastStatementOnly: IDatabase = {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await db.executeSql(text, values)
        return text.includes('"deletedRetained"') ? { rows: [] } : result
      }
    }

    const boss = new Boss(lastStatementOnly, new Manager(lastStatementOnly, config), config)
    boss.on('error', () => {})
    await boss.start()

    await expect(boss.supervise([queue])).rejects.toThrow('maintenance batch returned no result row')

    const { rows: [row] } = await db.executeSql(`SELECT retained_count FROM ${ctx.schema}.queue WHERE name = $1`, [ctx.schema])
    expect(row.retained_count).toBeNull()

    await boss.stop()
    if (!helper.isPglite) await db.close()
  })

  it('should hand back the maintenance claim when a walk fails, and report a release that fails', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })
    await ctx.boss.send(ctx.schema)
    const queue = await ctx.boss.getQueue(ctx.schema)
    assertTruthy(queue)

    const db = await helper.getDb()
    const config = Attorney.getConfig({ ...ctx.bossConfig, supervise: false })

    for (const failRelease of [false, true]) {
      const failing: IDatabase = {
        executeSql: async (text: string, values?: unknown[]) => {
          if (text.includes('"deletedRetained"')) throw new Error('batch failed')
          if (failRelease && text.includes('SET maintain_on = NULL')) throw new Error('release failed')
          return await db.executeSql(text, values)
        }
      }

      const boss = new Boss(failing, new Manager(failing, config), config)
      const errors: Error[] = []
      boss.on('error', err => errors.push(err))
      await boss.start()

      await expect(boss.supervise([queue])).rejects.toThrow('batch failed')
      expect(errors.map(err => err.message)).toEqual(failRelease ? ['release failed'] : [])

      const { rows: [row] } = await db.executeSql(`SELECT maintain_on IS NOT NULL AS claimed FROM ${ctx.schema}.queue WHERE name = $1`, [ctx.schema])
      expect(row.claimed).toBe(failRelease)

      await boss.stop()
    }

    if (!helper.isPglite) await db.close()
  })

  // A walk cut short has not counted what it kept, but the jobs its batches deleted are gone, so they
  // come off the counts at once rather than at the next pass a whole maintenance interval later.
  for (const interruption of ['stop', 'error'] as const) {
    it(`should take the jobs deleted so far off the counts when ${interruption === 'stop' ? 'stop() lands between' : 'a later batch fails among'} deletion batches`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })
      await Promise.all([1, 2, 3, 4, 5].map(() => ctx.boss!.send(ctx.schema, null, { deleteAfterSeconds: 1 })))
      const fetched = await ctx.boss.fetch(ctx.schema, { batchSize: 5 })
      await ctx.boss.complete(ctx.schema, fetched.map(job => job.id))

      const db = await helper.getDb()
      await db.executeSql(`UPDATE ${ctx.schema}.queue SET retained_count = 5, retained_on = ${ctx.schema}.job_now(), total_count = 5 WHERE name = $1`, [ctx.schema])
      await delay(1500)

      const queue = await ctx.boss.getQueue(ctx.schema)
      assertTruthy(queue)

      const config = Attorney.getConfig({ ...ctx.bossConfig, supervise: false, __test__walk_batch_size: 2 })
      let batches = 0

      const interrupting: IDatabase = {
        executeSql: async (text: string, values?: unknown[]) => {
          const deletion = text.includes('"walkCursor"') && text.includes('"deletedRetained"')
          if (deletion && interruption === 'error' && batches === 1) throw new Error('batch failed')
          const result = await db.executeSql(text, values)
          if (deletion && ++batches === 1 && interruption === 'stop') boss.stop()
          return result
        }
      }

      const boss = new Boss(interrupting, new Manager(interrupting, config), config)
      await boss.start()
      const supervised = await boss.supervise([queue]).then(() => null, (err: Error) => err)

      expect(batches).toBe(1)
      expect(supervised?.message ?? null).toBe(interruption === 'error' ? 'batch failed' : null)

      const { rows: [jobs] } = await db.executeSql(`SELECT count(*)::int AS count FROM ${ctx.schema}.job WHERE name = $1`, [ctx.schema])
      const { rows: [counts] } = await db.executeSql(`SELECT retained_count, total_count FROM ${ctx.schema}.queue WHERE name = $1`, [ctx.schema])
      // CockroachDB returns integers as strings.
      expect(Number(jobs.count)).toBe(3)
      expect({ retained: Number(counts.retained_count), total: Number(counts.total_count) }).toEqual({ retained: 3, total: 3 })

      if (!helper.isPglite) await db.close()
    })
  }

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
