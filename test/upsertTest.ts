import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as plans from '../src/plans.ts'

const SOME_UUID = '00000000-0000-0000-0000-000000000000'

describe('upsert', function () {
  // The JSONB key-existence operator `?` collides with knex's positional-binding parser (issue #837:
  // "Expected 1 bindings, saw 10"). The update SQL must use the jsonb_exists() function form instead.
  it('generates update SQL free of the ? operator (knex adapter compatibility)', function () {
    const sqls = [
      plans.updateJob('pgboss', 'job', 'q', 'id', 'newest'),
      plans.updateJob('pgboss', 'job', 'q', 'singletonKey', 'all', true),
      plans.updateQueue('pgboss', { deadLetter: 'dl' })
    ]
    for (const sql of sqls) {
      expect(sql).not.toMatch(/\?/)
      expect(sql).toContain('jsonb_exists(o.data,')
    }
  })

  it('should reject when neither id nor singletonKey is provided', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(ctx.boss.upsert(ctx.schema, { v: 1 })).rejects.toThrow(/exactly one of id or singletonKey/)
  })

  it('should reject when both id and singletonKey are provided', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(ctx.boss.upsert(ctx.schema, { v: 1 }, { id: SOME_UUID, singletonKey: 'k' })).rejects.toThrow(/exactly one/)
  })

  it('should reject upsert by id on a key_strict_fifo queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo' })
    await expect(ctx.boss.upsert(ctx.schema, { v: 1 }, { id: SOME_UUID })).rejects.toThrow(/key_strict_fifo/)
  })

  it('should insert a new job with the given id when none exists (by id)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const result = await ctx.boss.upsert(ctx.schema, { v: 1 }, { id: SOME_UUID })
    expect(result).toEqual({ jobs: [SOME_UUID], updated: 0, inserted: 1 })

    const job = await ctx.boss.getJobById(ctx.schema, SOME_UUID)
    assertTruthy(job)
    expect(job.data).toEqual({ v: 1 })
  })

  it('should update an existing pre-active job in place by id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 })
    assertTruthy(id)

    const result = await ctx.boss.upsert(ctx.schema, { v: 2 }, { id })
    expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })
  })

  it('should insert a new job when none exists for the key', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const result = await ctx.boss.upsert(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.jobs).toHaveLength(1)

    const job = await ctx.boss.getJobById(ctx.schema, result.jobs[0])
    assertTruthy(job)
    expect(job.data).toEqual({ v: 1 })
    expect(job.singletonKey).toBe('k')
  })

  it('should update the existing pre-active job in place, preserving its id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    assertTruthy(id)

    const result = await ctx.boss.upsert(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    expect(result).toEqual({ jobs: [id], updated: 1, inserted: 0 })

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })
  })

  it('should insert a fresh job when the existing one is already active', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    assertTruthy(id)

    const [fetched] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(fetched)

    const result = await ctx.boss.upsert(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).not.toBe(id)

    const job = await ctx.boss.getJobById(ctx.schema, result.jobs[0])
    assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })

    // the originally active job is untouched
    const original = await ctx.boss.getJobById(ctx.schema, id)
    expect(original!.state).toBe('active')
    expect(original!.data).toEqual({ v: 1 })
  })

  it('is a no-op when an active job already holds the key (exclusive policy)', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { policy: 'exclusive' })

    const id = await ctx.boss.send(ctx.schema, { v: 1 }, { singletonKey: 'k' })
    assertTruthy(id)

    const [fetched] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(fetched) // id -> active

    // exclusive policy: the update skips the active job, the insert conflicts on the
    // active row (job_i6 covers state <= active), and the retry-update still finds nothing.
    const result = await ctx.boss.upsert(ctx.schema, { v: 2 }, { singletonKey: 'k' })
    expect(result).toEqual({ jobs: [], updated: 0, inserted: 0 })

    const original = await ctx.boss.getJobById(ctx.schema, id)
    expect(original!.state).toBe('active')
    expect(original!.data).toEqual({ v: 1 })
  })

  it('replaces the single queued job on a short-policy queue (issue #548)', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { policy: 'short' })

    const first = await ctx.boss.upsert(ctx.schema, { body: 'v1' }, { singletonKey: 'article-42' })
    expect(first.inserted).toBe(1)
    expect(first.updated).toBe(0)
    const id = first.jobs[0]

    // a newer version arrives before the job is processed => overwrite in place, no duplicate
    const second = await ctx.boss.upsert(ctx.schema, { body: 'v2' }, { singletonKey: 'article-42' })
    expect(second).toEqual({ jobs: [id], updated: 1, inserted: 0 })

    // exactly one queued job remains, carrying the latest body
    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(id)
    expect(jobs[0].data).toEqual({ body: 'v2' })
  })

  describe('object API', function () {
    it('should insert then update a job passed as a single object argument', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const inserted = await ctx.boss.upsert({ name: ctx.schema, data: { v: 1 }, options: { id: SOME_UUID } })
      expect(inserted).toEqual({ jobs: [SOME_UUID], updated: 0, inserted: 1 })

      const updated = await ctx.boss.upsert({ name: ctx.schema, data: { v: 2 }, options: { id: SOME_UUID } })
      expect(updated).toEqual({ jobs: [SOME_UUID], updated: 1, inserted: 0 })

      const job = await ctx.boss.getJobById(ctx.schema, SOME_UUID)
      assertTruthy(job)
      expect(job.data).toEqual({ v: 2 })
    })

    it('should reject the object form when neither id nor singletonKey is provided', async function () {
      ctx.boss = await helper.start(ctx.bossConfig)
      await expect(ctx.boss.upsert({ name: ctx.schema, data: { v: 1 } })).rejects.toThrow(/exactly one of id or singletonKey/)
    })
  })
})
