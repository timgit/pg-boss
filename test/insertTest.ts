import { expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import type { JobInsert } from '../src/types.ts'

describe('insert', function () {
  it('should create jobs from an array', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const input = [{}, {}, {}]

    await ctx.boss.insert(ctx.schema, input)

    const [{ queuedCount }] = await ctx.boss.getQueueStats(ctx.schema)

    expect(queuedCount).toBe(3)
  })

  it('should create jobs from an array with all properties', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.updateQueue(ctx.schema, { deadLetter })

    const input = {
      id: randomUUID(),
      priority: 1,
      data: { some: 'data' },
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 3,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      deleteAfterSeconds: 60,
      singletonKey: '123',
      retentionSeconds: 60
    }

    const keepUntil = new Date(new Date(input.startAfter).getTime() + (input.retentionSeconds * 1000)).toISOString()

    await ctx.boss.insert(ctx.schema, [input])

    const job = await ctx.boss.getJobById(ctx.schema, input.id)

    expect(job).toBeTruthy()

    expect(job!.id).toBe(input.id)
    expect(job!.priority).toBe(input.priority)
    expect(JSON.stringify(job!.data)).toBe(JSON.stringify(input.data))
    expect(job!.retryLimit).toBe(input.retryLimit)
    expect(job!.retryDelay).toBe(input.retryDelay)
    expect(job!.retryBackoff).toBe(input.retryBackoff)
    expect(job!.retryDelayMax).toBe(input.retryDelayMax)
    expect(new Date(job!.startAfter).toISOString()).toBe(input.startAfter)
    expect(job!.expireInSeconds).toBe(input.expireInSeconds)
    expect(job!.deleteAfterSeconds).toBe(input.deleteAfterSeconds)
    expect(job!.singletonKey).toBe(input.singletonKey)
    expect(new Date(job!.keepUntil).toISOString()).toBe(keepUntil)
  })

  helper.itPglite('should create jobs from an array with all properties and custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.updateQueue(ctx.schema, { deadLetter })

    const input = {
      id: randomUUID(),
      priority: 1,
      data: { some: 'data' },
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 3,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      deleteAfterSeconds: 45,
      singletonKey: '123',
      retentionSeconds: 60
    }

    const keepUntil = new Date(new Date(input.startAfter).getTime() + (input.retentionSeconds * 1000)).toISOString()

    let called = false
    const db = await helper.getDb()
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          called = true
          return db.executeSql(sql, values)
        }
      }
    }

    await ctx.boss.insert(ctx.schema, [input], options)

    const job = await ctx.boss.getJobById(ctx.schema, input.id)

    expect(job).toBeTruthy()

    expect(job!.id).toBe(input.id)
    expect(job!.priority).toBe(input.priority)
    expect(JSON.stringify(job!.data)).toBe(JSON.stringify(input.data))
    expect(job!.retryLimit).toBe(input.retryLimit)
    expect(job!.retryDelay).toBe(input.retryDelay)
    expect(job!.retryBackoff).toBe(input.retryBackoff)
    expect(job!.retryDelayMax).toBe(input.retryDelayMax)
    expect(new Date(job!.startAfter).toISOString()).toBe(input.startAfter)
    expect(job!.expireInSeconds).toBe(input.expireInSeconds)
    expect(job!.deleteAfterSeconds).toBe(input.deleteAfterSeconds)
    expect(job!.singletonKey).toBe(input.singletonKey)
    expect(new Date(job!.keepUntil).toISOString()).toBe(keepUntil)
    expect(called).toBe(true)
  })

  helper.itPglite('should create jobs with deadLetter the queue name of the ones passed as option in the send method if the queue deadLetter property is empty', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)

    const input = {
      id: randomUUID(),
      deadLetter
    }

    let called = false
    const db = await helper.getDb()
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          called = true
          return db.executeSql(sql, values)
        }
      }
    }

    await ctx.boss.insert(ctx.schema, [input], options)

    const job = await ctx.boss.getJobById(ctx.schema, input.id)
    expect(job).toBeTruthy()

    expect(called).toBe(true)
    expect(job!.deadLetter).toBe(input.deadLetter)
  })

  it('should persist group id and tier', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const input = {
      id: randomUUID(),
      group: { id: 'group1', tier: 'tier1' }
    }

    await ctx.boss.insert(ctx.schema, [input])

    const job = await ctx.boss.getJobById(ctx.schema, input.id)

    expect(job!.groupId).toBe(input.group.id)
    expect(job!.groupTier).toBe(input.group.tier)
  })

  it('should persist group id when tier is omitted', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const input = {
      id: randomUUID(),
      group: { id: 'group1' }
    }

    await ctx.boss.insert(ctx.schema, [input])

    const job = await ctx.boss.getJobById(ctx.schema, input.id)

    expect(job!.groupId).toBe(input.group.id)
    expect(job!.groupTier).toBe(null)
  })

  it('should not clobber raw groupId/groupTier fields', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // insertJobs' json_to_recordset declares groupId/groupTier columns directly, so passing those
    // raw names through insert() has always worked — it was the natural workaround while insert()
    // was dropping `group`. Not a documented contract, but flattening `group` must not overwrite
    // them with undefined, or that workaround breaks in exactly the way it was compensating for.
    const input = { id: randomUUID(), groupId: 'group1', groupTier: 'tier1' }

    await ctx.boss.insert(ctx.schema, [input as JobInsert])

    const job = await ctx.boss.getJobById(ctx.schema, input.id)

    expect(job!.groupId).toBe(input.groupId)
    expect(job!.groupTier).toBe(input.groupTier)
  })

  it('should reject an invalid group', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // insert() skips Attorney otherwise, but an empty group.id would silently become a real
    // concurrency group named '' once persisted, so it is validated the same way send() does.
    await expect(ctx.boss.insert(ctx.schema, [{ group: { id: '' } }]))
      .rejects.toThrow('group.id must be a non-empty string')

    await expect(ctx.boss.insert(ctx.schema, [{ group: { id: 'group1', tier: '' } }]))
      .rejects.toThrow('group.tier must be a non-empty string if provided')

    const [{ queuedCount }] = await ctx.boss.getQueueStats(ctx.schema)
    expect(queuedCount).toBe(0)
  })

  it('should honor groupConcurrency for jobs created by insert', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // The group columns are only useful if the fetch plan sees them, so prove the round trip
    // rather than just the persisted row: 4 jobs in one group, groupConcurrency of 2.
    const groupId = 'tenant-1'
    await ctx.boss.insert(ctx.schema, [
      { group: { id: groupId } },
      { group: { id: groupId } },
      { group: { id: groupId } },
      { group: { id: groupId } }
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 4, groupConcurrency: 2 })

    expect(jobs.length).toBe(2)
    expect(jobs.every(job => job.groupId === groupId)).toBe(true)
  })

  it('should attribute insert spy data to the right id when ON CONFLICT skips a job', async function () {
    // insertJobs ends in ON CONFLICT DO NOTHING; on a short-policy queue a duplicate singletonKey is
    // skipped, so the returned rows no longer align positionally with the input jobs. The spy must
    // map each returned id back to its own job's data — a positional rows[i] <-> jobs[i] pairing
    // would attribute the skipped job's data to a surviving id.
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, __test__enableSpies: true })
    await ctx.boss.createQueue(ctx.schema, { policy: 'short' })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobs = [
      { data: { tag: 'A' }, singletonKey: 'k1' },
      { data: { tag: 'B' }, singletonKey: 'k1' }, // conflicts with A on job_i1, skipped
      { data: { tag: 'C' }, singletonKey: 'k2' }
    ]

    const ids = await ctx.boss.insert(ctx.schema, jobs)
    expect(ids).toHaveLength(2)

    const tags = new Set<string>()
    for (const id of ids!) {
      const job = await spy.waitForJobWithId(id, 'created')
      tags.add((job.data as { tag: string }).tag)
    }

    // Skipped job B's data must never be attributed to a surviving id.
    expect(tags).toEqual(new Set(['A', 'C']))
  })

  it('should track insert spy jobs that supply an explicit id or omit data', async function () {
    // Exercises both sides of the spy-only id/data normalization: a job carrying its own id keeps
    // it, a job with no data is tracked as {}.
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, __test__enableSpies: true })
    await ctx.boss.createQueue(ctx.schema)
    const spy = ctx.boss.getSpy(ctx.schema)

    const explicitId = randomUUID()
    const ids = await ctx.boss.insert(ctx.schema, [
      { id: explicitId, data: { tag: 'X' } },
      {}
    ])
    expect(ids).toHaveLength(2)

    const withId = await spy.waitForJobWithId(explicitId, 'created')
    expect((withId.data as { tag: string }).tag).toBe('X')

    const otherId = ids!.find(id => id !== explicitId)!
    const noData = await spy.waitForJobWithId(otherId, 'created')
    expect(noData.data).toEqual({})
  })

  it('should throw when the same explicit id appears twice in one insert batch', async function () {
    // ON CONFLICT DO NOTHING would otherwise silently drop the duplicate; fail fast instead so a
    // lost job surfaces as an error.
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema)

    const dupe = randomUUID()
    await expect(ctx.boss.insert(ctx.schema, [
      { id: dupe, data: { n: 1 } },
      { id: dupe, data: { n: 2 } }
    ])).rejects.toThrow(`duplicate job id in insert batch: ${dupe}`)

    // Jobs without explicit ids never collide.
    const ids = await ctx.boss.insert(ctx.schema, [{}, {}], { returnId: true })
    expect(ids).toHaveLength(2)
  })
})
