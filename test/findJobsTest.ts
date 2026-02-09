import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import type { JobsConfig } from '../src/types.ts'
import { PgBoss } from '../src/index.ts'

describe('findJobs', function () {
  it('should reject missing queue argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.findJobs()
    }).rejects.toThrow()
  })

  it('should find a job by id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { foo: 'bar' })
    helper.assertTruthy(jobId)

    const jobs = await ctx.boss.findJobs(ctx.schema, { id: jobId })

    expect(jobs.length).toBe(1)
    expect(jobs[0].id).toBe(jobId)
    expect(jobs[0].data).toEqual({ foo: 'bar' })
  })

  it('should find a job by singletonKey', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { test: 1 }, { singletonKey: 'my-unique-key' })
    helper.assertTruthy(jobId)

    // Send another job without singletonKey
    await ctx.boss.send(ctx.schema, { test: 2 })

    const jobs = await ctx.boss.findJobs(ctx.schema, { key: 'my-unique-key' })

    expect(jobs.length).toBe(1)
    expect(jobs[0].id).toBe(jobId)
    expect(jobs[0].singletonKey).toBe('my-unique-key')
  })

  it('should find jobs by data', async function () {
    const boss = await helper.start<{
      name: { input: { type: string, to: string }, output: {} },
    }>(ctx.bossConfig)
    ctx.boss = boss as unknown as PgBoss<JobsConfig>
    const schema = ctx.schema as 'name'

    await boss.send(schema, { type: 'email', to: 'user1@test.com' })
    await boss.send(schema, { type: 'email', to: 'user2@test.com' })
    await boss.send(schema, { type: 'sms', to: '555-1234' })

    const emailJobs = await boss.findJobs(schema, { data: { type: 'email' } })

    expect(emailJobs.length).toBe(2)
    expect(emailJobs.every(j => j.data?.type === 'email')).toBe(true)
  })

  it('should find jobs by data matching 2 key value pairs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const data1 = { type: 'email', to: 'your@mom.com' }

    await ctx.boss.send(ctx.schema, { foo: 'bar' })
    await ctx.boss.send(ctx.schema, data1)
    await ctx.boss.send(ctx.schema)

    const jobs = await ctx.boss.findJobs(ctx.schema, { data: data1 })

    assert(jobs.length === 1, `Expected 1 job, found ${jobs.length}`)

    expect(jobs[0].data).toEqual(data1)
  })

  it('should find only queued jobs when queued option is true', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // Create jobs
    const jobId1 = await ctx.boss.send(ctx.schema, { order: 1 })
    const jobId2 = await ctx.boss.send(ctx.schema, { order: 2 })
    helper.assertTruthy(jobId1)
    helper.assertTruthy(jobId2)

    // Fetch one job to make it active
    await ctx.boss.fetch(ctx.schema)

    // Find only queued jobs
    const queuedJobs = await ctx.boss.findJobs(ctx.schema, { queued: true })

    expect(queuedJobs.length).toBe(1)
    expect(queuedJobs[0].state).toMatch(/created|retry/)
  })

  it('should find all jobs when queued option is false', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, { order: 1 })
    await ctx.boss.send(ctx.schema, { order: 2 })

    // Fetch one job to make it active
    await ctx.boss.fetch(ctx.schema)

    // Find all jobs (default queued: false)
    const allJobs = await ctx.boss.findJobs(ctx.schema)

    expect(allJobs.length).toBe(2)
  })

  it('should combine id and queued filters', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { test: 1 })
    helper.assertTruthy(jobId)

    // Fetch the job to make it active
    await ctx.boss.fetch(ctx.schema)

    // Should not find the job when filtering for queued only
    const queuedJobs = await ctx.boss.findJobs(ctx.schema, { id: jobId, queued: true })
    expect(queuedJobs.length).toBe(0)

    // Should find the job without queued filter
    const allJobs = await ctx.boss.findJobs(ctx.schema, { id: jobId })
    expect(allJobs.length).toBe(1)
  })

  it('should combine key and data filters', async function () {
    const boss = await helper.start<{
      name: { input: { category: string, value: number }, output: {} },
    }>(ctx.bossConfig)
    ctx.boss = boss as unknown as PgBoss<JobsConfig>
    const schema = ctx.schema as 'name'

    await boss.send(schema, { category: 'A', value: 1 }, { singletonKey: 'key-1' })
    await boss.send(schema, { category: 'B', value: 2 }, { singletonKey: 'key-1' })
    await boss.send(schema, { category: 'A', value: 3 }, { singletonKey: 'key-2' })

    const jobs = await boss.findJobs(schema, {
      key: 'key-1',
      data: { category: 'A' }
    })

    expect(jobs.length).toBe(1)
    expect(jobs[0].singletonKey).toBe('key-1')
    expect(jobs[0].data.category).toBe('A')
  })

  it('should return empty array when no jobs match', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, { test: 1 })

    const jobs = await ctx.boss.findJobs(ctx.schema, { id: '00000000-0000-0000-0000-000000000000' })

    expect(jobs).toEqual([])
  })

  it('should return all metadata for found jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, { test: 1 }, {
      singletonKey: 'meta-test',
      priority: 5
    })
    helper.assertTruthy(jobId)

    const jobs = await ctx.boss.findJobs(ctx.schema, { id: jobId })

    expect(jobs.length).toBe(1)
    const job = jobs[0]

    expect(job.id).toBe(jobId)
    expect(job.name).toBe(ctx.schema)
    expect(job.singletonKey).toBe('meta-test')
    expect(job.priority).toBe(5)
    expect(job.state).toBeDefined()
    expect(job.retryLimit).toBeDefined()
    expect(job.retryCount).toBeDefined()
    expect(job.createdOn).toBeDefined()
    expect(job.startAfter).toBeDefined()
  })

  it('should combine all filters together', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const targetId = await ctx.boss.send(ctx.schema, { type: 'target', value: 42 }, { singletonKey: 'unique' })
    helper.assertTruthy(targetId)

    await ctx.boss.send(ctx.schema, { type: 'other', value: 1 }, { singletonKey: 'unique' })
    await ctx.boss.send(ctx.schema, { type: 'target', value: 2 }, { singletonKey: 'different' })

    const jobs = await ctx.boss.findJobs(ctx.schema, {
      id: targetId,
      key: 'unique',
      data: { type: 'target' },
      queued: true
    })

    expect(jobs.length).toBe(1)
    expect(jobs[0].id).toBe(targetId)
  })
})
