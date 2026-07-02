import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { delay } from '../src/tools.ts'

const MISSING_UUID = '00000000-0000-0000-0000-000000000000'

describe('update', function () {
  it('should reject when neither id nor singletonKey is provided', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(ctx.boss.update(ctx.schema, { v: 1 })).rejects.toThrow(/exactly one of id or singletonKey/)
  })

  it('should reject when both id and singletonKey are provided', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(ctx.boss.update(ctx.schema, { v: 1 }, { id: MISSING_UUID, singletonKey: 'k' })).rejects.toThrow(/exactly one/)
  })

  it('should reject match when targeting by id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(ctx.boss.update(ctx.schema, { v: 1 }, { id: MISSING_UUID, match: 'all' })).rejects.toThrow(/match is only valid/)
  })

  it('should reject an invalid match strategy', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    // @ts-ignore
    await expect(ctx.boss.update(ctx.schema, { v: 1 }, { singletonKey: 'k', match: 'bogus' })).rejects.toThrow(/match must be one of/)
  })

  it('should update a created job by id and preserve its id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 })
    assertTruthy(id)

    const result = await ctx.boss.update(ctx.schema, { v: 2 }, { id })
    expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })
  })

  it('should update scheduling options by id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { priority: 1 })
    assertTruthy(id)

    await ctx.boss.update(ctx.schema, { v: 2 }, { id, priority: 5 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(job.priority).toBe(5)
  })

  it('should not update (or create) when the job is already active', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 })
    assertTruthy(id)

    const [fetched] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(fetched)

    const result = await ctx.boss.update(ctx.schema, { v: 2 }, { id })
    expect(result).toEqual({ jobs: [], updated: 0, inserted: 0 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(job.data).toEqual({ v: 1 })
  })

  it('should return an empty array when the job id does not exist', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const result = await ctx.boss.update(ctx.schema, { v: 2 }, { id: MISSING_UUID })
    expect(result).toEqual({ jobs: [], updated: 0, inserted: 0 })
  })

  it('should update a created job by singletonKey', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    assertTruthy(id)

    const result = await ctx.boss.update(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })
  })

  it('should return an empty array when no job matches the singletonKey', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const result = await ctx.boss.update(ctx.schema, { v: 2 }, { singletonKey: 'nope' })
    expect(result).toEqual({ jobs: [], updated: 0, inserted: 0 })
  })

  describe('multiple matches', function () {
    // A standard queue allows several pre-active jobs to share a singletonKey.
    async function seedThree () {
      const boss = ctx.boss = await helper.start(ctx.bossConfig)

      const id1 = await boss.send(ctx.schema, { n: 1 }, { singletonKey: 'k' })
      await delay(10)
      const id2 = await boss.send(ctx.schema, { n: 2 }, { singletonKey: 'k' })
      await delay(10)
      const id3 = await boss.send(ctx.schema, { n: 3 }, { singletonKey: 'k' })

      assertTruthy(id1)
      assertTruthy(id2)
      assertTruthy(id3)

      return { boss, id1, id2, id3 }
    }

    it('match: newest overwrites only the most recently created job', async function () {
      const { boss, id1, id2, id3 } = await seedThree()

      const result = await boss.update(ctx.schema, { updated: true }, { singletonKey: 'k', match: 'newest' })
      expect(result).toEqual({ jobs: [id3], updated: 1, inserted: 0 })

      const [j1, j2, j3] = await Promise.all([
        boss.getJobById(ctx.schema, id1),
        boss.getJobById(ctx.schema, id2),
        boss.getJobById(ctx.schema, id3)
      ])

      expect(j1!.data).toEqual({ n: 1 })
      expect(j2!.data).toEqual({ n: 2 })
      expect(j3!.data).toEqual({ updated: true })
    })

    it('match: oldest overwrites only the earliest created job', async function () {
      const { boss, id1, id3 } = await seedThree()

      const result = await boss.update(ctx.schema, { updated: true }, { singletonKey: 'k', match: 'oldest' })
      expect(result).toEqual({ jobs: [id1], updated: 1, inserted: 0 })

      const j1 = await boss.getJobById(ctx.schema, id1)
      const j3 = await boss.getJobById(ctx.schema, id3)
      expect(j1!.data).toEqual({ updated: true })
      expect(j3!.data).toEqual({ n: 3 })
    })

    it('match: all overwrites every matching job', async function () {
      const { boss, id1, id2, id3 } = await seedThree()

      const result = await boss.update(ctx.schema, { updated: true }, { singletonKey: 'k', match: 'all' })
      expect([...result.jobs].sort()).toEqual([id1, id2, id3].sort())
      expect(result.updated).toBe(3)
      expect(result.inserted).toBe(0)

      const jobs = await Promise.all([
        boss.getJobById(ctx.schema, id1),
        boss.getJobById(ctx.schema, id2),
        boss.getJobById(ctx.schema, id3)
      ])

      for (const job of jobs) {
        expect(job!.data).toEqual({ updated: true })
      }
    })

    it('defaults to newest when match is omitted', async function () {
      const { boss, id3 } = await seedThree()
      const result = await boss.update(ctx.schema, { updated: true }, { singletonKey: 'k' })
      expect(result).toEqual({ jobs: [id3], updated: 1, inserted: 0 })
    })
  })

  describe('partial edit', function () {
    it('editing data by id leaves other options untouched', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const startAfter = new Date(Date.now() + 60_000).toISOString()
      const id = await ctx.boss.send(ctx.schema, { v: 1 }, { priority: 5, startAfter })
      assertTruthy(id)

      const result = await ctx.boss.update(ctx.schema, { v: 2 }, { id })
      expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)
      expect(job.data).toEqual({ v: 2 })
      expect(job.priority).toBe(5)
      expect(new Date(job.startAfter).toISOString()).toBe(startAfter)
    })

    it('editing one option leaves data and the rest untouched', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const startAfter = new Date(Date.now() + 60_000).toISOString()
      const id = await ctx.boss.send(ctx.schema, { keep: 'me' }, { priority: 5, startAfter })
      assertTruthy(id)

      // pass undefined data => payload untouched, only priority changes
      await ctx.boss.update(ctx.schema, undefined, { id, priority: 9 })

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)
      expect(job.priority).toBe(9)
      expect(job.data).toEqual({ keep: 'me' })
      expect(new Date(job.startAfter).toISOString()).toBe(startAfter)
    })

    it('editing by singletonKey leaves other options untouched', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const startAfter = new Date(Date.now() + 60_000).toISOString()
      const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k', priority: 3, startAfter })
      assertTruthy(id)

      await ctx.boss.update(ctx.schema, { v: 2 }, { singletonKey: 'k' })

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)
      expect(job.data).toEqual({ v: 2 })
      expect(job.priority).toBe(3)
      expect(new Date(job.startAfter).toISOString()).toBe(startAfter)
    })
  })

  describe('object API', function () {
    it('should update a job passed as a single object argument', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const id = await ctx.boss.send(ctx.schema, { v: 1 })
      assertTruthy(id)

      const result = await ctx.boss.update({ name: ctx.schema, data: { v: 2 }, options: { id } })
      expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)
      expect(job.data).toEqual({ v: 2 })
    })

    it('should edit only options when data is omitted', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const id = await ctx.boss.send(ctx.schema, { keep: 'me' }, { priority: 1 })
      assertTruthy(id)

      await ctx.boss.update({ name: ctx.schema, options: { id, priority: 9 } })

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)
      expect(job.priority).toBe(9)
      expect(job.data).toEqual({ keep: 'me' })
    })

    it('should reject the object form when neither id nor singletonKey is provided', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      await expect(ctx.boss.update({ name: ctx.schema, data: { v: 1 } })).rejects.toThrow(/exactly one of id or singletonKey/)
    })

    it('should reject the object form with more than one argument', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      // @ts-ignore - deliberately misusing the object overload
      await expect(ctx.boss.update({ name: ctx.schema, options: { id: MISSING_UUID } }, { v: 1 })).rejects.toThrow(/object API only accepts 1 argument/)
    })
  })

  it('should work on a partitioned queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { partition: true })

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    assertTruthy(id)

    const result = await ctx.boss.update(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    expect(job!.data).toEqual({ v: 2 })
  })
})
