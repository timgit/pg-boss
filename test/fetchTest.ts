import { expect, vi } from 'vitest'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import { ctx } from './hooks.ts'

describe('fetch', function () {
  it('surfaces a non-unique-violation fetch error instead of swallowing it into []', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // warm the queue cache so the mocked failure hits the fetch query, not getQueueCache
    await ctx.boss.fetch(ctx.schema)

    const db = ctx.boss.getDb()
    const spy = vi.spyOn(db, 'executeSql')
      .mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '08006' }))

    await expect(ctx.boss.fetch(ctx.schema)).rejects.toThrow('connection terminated')

    spy.mockRestore()
  })

  it('still treats a unique-constraint violation as an empty fetch', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.fetch(ctx.schema)

    const db = ctx.boss.getDb()
    const spy = vi.spyOn(db, 'executeSql')
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))

    const jobs = await ctx.boss.fetch(ctx.schema)
    expect(jobs).toEqual([])

    spy.mockRestore()
  })
  it('fetchNextJob treats a null ignoreSingletons entry as the empty key (no queue-wide stall)', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await boss.createQueue(ctx.schema, { policy: 'singleton' })

    // a pending keyed job that should remain fetchable
    const id = await boss.send(ctx.schema, { v: 1 }, { singletonKey: 'b' })
    helper.assertTruthy(id)

    // Simulate the queue cache reporting a keyless active singleton job (singletonsActive = [null],
    // from getQueueStats' array_agg over a NULL singleton_key). Before the fix this rendered
    // `singleton_key <> ALL(array[NULL])` as NULL for every row, so NOTHING fetched and the whole
    // queue stalled. The null must be treated as the empty key, blocking only keyless jobs.
    const query = plans.fetchNextJob({
      schema: ctx.schema,
      table: 'job_common',
      name: ctx.schema,
      policy: 'singleton',
      limit: 1,
      ignoreSingletons: [null as unknown as string]
    })

    const { rows } = await boss.getDb().executeSql(query.text, query.values)
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(id)
  })
  it('should reject missing queue argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.fetch()
    }).rejects.toThrow()
  })

  it('should fetch a job by name manually', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job.name).toBe(ctx.schema)
  })

  it('should get a batch of jobs as an array', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const batchSize = 4

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize })

    expect(jobs.length === batchSize).toBeTruthy()
  })

  it('should fetch all metadata for a single job when requested', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true })

    expect(job.name).toBe(ctx.schema)
    expect(job.state).toBe('active')

    expect(job.priority !== undefined).toBeTruthy()
    expect(job.policy !== undefined).toBeTruthy()
    expect(job.retryLimit !== undefined).toBeTruthy()
    expect(job.retryCount !== undefined).toBeTruthy()
    expect(job.retryDelay !== undefined).toBeTruthy()
    expect(job.retryBackoff).toBe(false)
    expect(job.retryDelayMax !== undefined).toBeTruthy()
    expect(job.startAfter !== undefined).toBeTruthy()
    expect(job.startedOn !== undefined).toBeTruthy()
    expect(job.singletonKey !== undefined).toBeTruthy()
    expect(job.singletonOn !== undefined).toBeTruthy()
    expect(job.expireInSeconds !== undefined).toBeTruthy()
    expect(job.deleteAfterSeconds !== undefined).toBeTruthy()
    expect(job.createdOn !== undefined).toBeTruthy()
    expect(job.completedOn !== undefined).toBeTruthy()
    expect(job.keepUntil !== undefined).toBeTruthy()
    expect(job.deadLetter !== undefined).toBeTruthy()
  })

  it('should fetch all metadata for a batch of jobs when requested', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const batchSize = 4

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize, includeMetadata: true })
    expect(jobs.length === batchSize).toBeTruthy()

    for (const job of jobs) {
      expect(job.name).toBe(ctx.schema)
      expect(job.state).toBe('active')
      expect(job.priority !== undefined).toBeTruthy()
      expect(job.policy !== undefined).toBeTruthy()
      expect(job.retryLimit !== undefined).toBeTruthy()
      expect(job.retryCount !== undefined).toBeTruthy()
      expect(job.retryDelay !== undefined).toBeTruthy()
      expect(job.retryBackoff).toBe(false)
      expect(job.retryDelayMax !== undefined).toBeTruthy()
      expect(job.startAfter !== undefined).toBeTruthy()
      expect(job.startedOn !== undefined).toBeTruthy()
      expect(job.singletonKey).toBe(null)
      expect(job.singletonOn).toBe(null)
      expect(job.expireInSeconds !== undefined).toBeTruthy()
      expect(job.createdOn !== undefined).toBeTruthy()
      expect(job.completedOn).toBe(null)
      expect(job.keepUntil !== undefined).toBeTruthy()
    }
  })

  it('should fetch all metadata for a single job with exponential backoff when requested', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 1, retryBackoff: true, retryDelayMax: 10 })
    const [job] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true })

    expect(job.name).toBe(ctx.schema)
    expect(job.priority).toBe(0)
    expect(job.state).toBe('active')
    expect(job.policy !== undefined).toBeTruthy()
    expect(job.retryLimit).toBe(1)
    expect(job.retryCount).toBe(0)
    expect(job.retryDelay).toBe(1)
    expect(job.retryBackoff).toBe(true)
    expect(job.retryDelayMax).toBe(10)
    expect(job.startAfter !== undefined).toBeTruthy()
    expect(job.startedOn !== undefined).toBeTruthy()
    expect(job.singletonKey).toBe(null)
    expect(job.singletonOn).toBe(null)
    expect(job.expireInSeconds !== undefined).toBeTruthy()
    expect(job.createdOn !== undefined).toBeTruthy()
    expect(job.completedOn).toBe(null)
    expect(job.keepUntil !== undefined).toBeTruthy()
  })

  it('should fetch all metadata for a batch of jobs with exponential backoff when requested', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const options = { retryDelay: 1, retryBackoff: true, retryDelayMax: 10 }
    const batchSize = 4

    await Promise.all([
      ctx.boss.send(ctx.schema, null, options),
      ctx.boss.send(ctx.schema, null, options),
      ctx.boss.send(ctx.schema, null, options),
      ctx.boss.send(ctx.schema, null, options)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize, includeMetadata: true })
    expect(jobs.length === batchSize).toBeTruthy()

    for (const job of jobs) {
      expect(job.name).toBe(ctx.schema)
      expect(job.priority).toBe(0)
      expect(job.state).toBe('active')
      expect(job.policy !== undefined).toBeTruthy()
      expect(job.retryLimit !== undefined).toBeTruthy()
      expect(job.retryCount).toBe(0)
      expect(job.retryDelay).toBe(1)
      expect(job.retryBackoff).toBe(true)
      expect(job.retryDelayMax).toBe(10)
      expect(job.startAfter !== undefined).toBeTruthy()
      expect(job.startedOn !== undefined).toBeTruthy()
      expect(job.singletonKey !== undefined).toBeTruthy()
      expect(job.singletonOn !== undefined).toBeTruthy()
      expect(job.expireInSeconds !== undefined).toBeTruthy()
      expect(job.deleteAfterSeconds !== undefined).toBeTruthy()
      expect(job.createdOn !== undefined).toBeTruthy()
      expect(job.completedOn !== undefined).toBeTruthy()
      expect(job.keepUntil !== undefined).toBeTruthy()
      expect(job.deadLetter !== undefined).toBeTruthy()
    }
  })

  helper.itPglite('should fetch a job with custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    let calledCounter = 0
    const db = await helper.getDb()
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          calledCounter++
          // @ts-ignore
          return db.pool.query(sql, values)
        }
      }
    }

    await ctx.boss.send(ctx.schema, {}, options)
    const [job] = await ctx.boss.fetch(ctx.schema, { ...options, batchSize: 10 })
    expect(job.name).toBe(ctx.schema)
    expect(calledCounter).toBe(2)
  })

  helper.itPglite('should allow fetching jobs that have a start_after in the future', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { startAfter: new Date(Date.now() + 1000) })
    const db = await helper.getDb()
    const sqlStatements : string[] = []
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          sqlStatements.push(sql)
          // @ts-ignore
          return db.pool.query(sql, values)
        }
      }
    }

    const jobs = await ctx.boss.fetch(ctx.schema, { ...options, ignoreStartAfter: true })
    expect(jobs.length).toBe(1)
    expect(sqlStatements.length).toBe(1)
    expect(sqlStatements[0]).not.toContain('start_after')
  })

  helper.itPglite('should not fetch jobs that have a start_after in the future by default', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { startAfter: new Date(Date.now() + 1000) })
    const db = await helper.getDb()
    const sqlStatements : string[] = []
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          sqlStatements.push(sql)
          // @ts-ignore
          return db.pool.query(sql, values)
        }
      }
    }

    const jobs = await ctx.boss.fetch(ctx.schema, options)
    expect(jobs.length).toBe(0)
    expect(sqlStatements.length).toBe(1)
    expect(sqlStatements[0]).toContain('start_after <= now()')
  })
})
