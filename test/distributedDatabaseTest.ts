import { expect, describe, it } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('distributed database mode', function () {
  it('should fetch a job with distributedDatabaseMode enabled', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job.name).toBe(ctx.schema)
  })

  it('should get a batch of jobs with distributedDatabaseMode enabled', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })
    const batchSize = 4

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize })

    expect(jobs.length).toBe(batchSize)
  })

  it('should fetch with metadata in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true })

    expect(job.name).toBe(ctx.schema)
    expect(job.state).toBe('active')
    expect(job.priority).toBe(0)
  })

  it('should respect priority ordering in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    // Send jobs with different priorities
    await ctx.boss.send(ctx.schema, { value: 'low' }, { priority: 1 })
    await ctx.boss.send(ctx.schema, { value: 'high' }, { priority: 10 })
    await ctx.boss.send(ctx.schema, { value: 'medium' }, { priority: 5 })

    // Fetch one job at a time to verify priority selection order
    const job1 = await ctx.boss.fetch<{ value: string }>(ctx.schema)
    expect(job1.length).toBe(1)
    expect(job1[0].data.value).toBe('high') // Highest priority first

    const job2 = await ctx.boss.fetch<{ value: string }>(ctx.schema)
    expect(job2.length).toBe(1)
    expect(job2[0].data.value).toBe('medium') // Second highest

    const job3 = await ctx.boss.fetch<{ value: string }>(ctx.schema)
    expect(job3.length).toBe(1)
    expect(job3[0].data.value).toBe('low') // Lowest priority last
  })

  it('should not duplicate jobs when fetching concurrently in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })
    const jobCount = 10

    await Promise.all(
      Array.from({ length: jobCount }, (_, i) => ctx.boss!.send(ctx.schema, { index: i }))
    )

    // Fetch concurrently from multiple "workers"
    const results = await Promise.all([
      ctx.boss.fetch(ctx.schema, { batchSize: jobCount }),
      ctx.boss.fetch(ctx.schema, { batchSize: jobCount }),
      ctx.boss.fetch(ctx.schema, { batchSize: jobCount })
    ])

    const allJobs = results.flat()

    // Each job should only be fetched once (no duplicates)
    // This is the key guarantee of the distributed mode
    const jobIds = allJobs.map(j => j.id)
    const uniqueJobIds = new Set(jobIds)
    expect(uniqueJobIds.size).toBe(jobIds.length)

    // Due to concurrent contention, not all jobs may be claimed in one round
    // but no job should be duplicated
    expect(allJobs.length).toBeLessThanOrEqual(jobCount)
    expect(allJobs.length).toBeGreaterThan(0)
  })

  it('should complete jobs fetched in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'data' })
    helper.assertTruthy(jobId)

    const fetchedJobs = await ctx.boss.fetch(ctx.schema)

    expect(fetchedJobs.length).toBe(1)

    const job = fetchedJobs[0]
    expect(job).toBeDefined()
    expect(job.id).toBe(jobId)

    await ctx.boss!.complete(ctx.schema, job.id)

    // Should not be able to fetch again
    const jobs = await ctx.boss.fetch(ctx.schema)
    expect(jobs.length).toBe(0)
  })

  it('should work with group concurrency in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const groupId = 'test-group'

    // Send jobs with same group
    await ctx.boss.send(ctx.schema, { value: 1 }, { group: { id: groupId } })
    await ctx.boss.send(ctx.schema, { value: 2 }, { group: { id: groupId } })
    await ctx.boss.send(ctx.schema, { value: 3 }, { group: { id: groupId } })

    // Fetch with group concurrency limit of 1
    const jobs1 = await ctx.boss.fetch(ctx.schema, { batchSize: 10, groupConcurrency: 1 })
    expect(jobs1.length).toBe(1)
    expect(jobs1[0]).toBeDefined()
    expect(jobs1[0].id).toBeDefined()

    // Complete the first job
    await ctx.boss!.complete(ctx.schema, jobs1[0].id)

    // Now we should be able to fetch another
    const jobs2 = await ctx.boss.fetch(ctx.schema, { batchSize: 10, groupConcurrency: 1 })
    expect(jobs2.length).toBe(1)
    expect(jobs2[0]).toBeDefined()
  })

  it('should work with work() handler in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const processedJobs: string[] = []

    await ctx.boss.send(ctx.schema, { value: 'test1' })
    await ctx.boss.send(ctx.schema, { value: 'test2' })

    await new Promise<void>((resolve, reject) => {
      let count = 0
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for jobs')), 5000)

      ctx.boss!.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
        for (const job of jobs) {
          processedJobs.push(job.id)
          count++
          if (count >= 2) {
            clearTimeout(timeout)
            resolve()
          }
        }
      })
    })

    expect(processedJobs.length).toBe(2)
  })

  it('should work with singleton policy in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'singleton' })

    await ctx.boss.send(ctx.schema, { value: 1 })
    await ctx.boss.send(ctx.schema, { value: 2 })

    // First fetch should get a job
    const [job1] = await ctx.boss.fetch(ctx.schema)
    expect(job1).toBeTruthy()

    // Second fetch should get nothing (singleton only allows 1 active)
    const [job2] = await ctx.boss.fetch(ctx.schema)
    expect(job2).toBeFalsy()

    // Complete the first job
    await ctx.boss.complete(ctx.schema, job1.id)

    // Now we should be able to fetch the second job
    const [job3] = await ctx.boss.fetch(ctx.schema)
    expect(job3).toBeTruthy()
  })

  it('should fetch jobs in retry state in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    const jobId = await ctx.boss.send(ctx.schema, { test: 'retry' }, { retryLimit: 3 })
    helper.assertTruthy(jobId)

    // Fetch and fail the job to put it in retry state
    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job).toBeTruthy()
    expect(job.id).toBe(jobId)

    await ctx.boss.fail(ctx.schema, jobId)

    // Job should now be in retry state
    const jobData = await ctx.boss.getJobById(ctx.schema, jobId)
    helper.assertTruthy(jobData)
    expect(jobData.state).toBe('retry')

    // Should be able to fetch the job again (retry state is < 'active')
    const [retryJob] = await ctx.boss.fetch(ctx.schema)
    expect(retryJob).toBeTruthy()
    expect(retryJob.id).toBe(jobId)
  })

  it('should fetch jobs without priority ordering in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    // Send jobs with different priorities but we'll fetch without priority ordering
    await ctx.boss.send(ctx.schema, { value: 'first' }, { priority: 1 })
    await ctx.boss.send(ctx.schema, { value: 'second' }, { priority: 10 })
    await ctx.boss.send(ctx.schema, { value: 'third' }, { priority: 5 })

    // Fetch without priority - should get jobs by created_on order
    const [job1] = await ctx.boss.fetch<{ value: string }>(ctx.schema, { priority: false })
    expect(job1).toBeTruthy()
    expect(job1.data.value).toBe('first') // First created, not highest priority

    const [job2] = await ctx.boss.fetch<{ value: string }>(ctx.schema, { priority: false })
    expect(job2).toBeTruthy()
    expect(job2.data.value).toBe('second') // Second created

    const [job3] = await ctx.boss.fetch<{ value: string }>(ctx.schema, { priority: false })
    expect(job3).toBeTruthy()
    expect(job3.data.value).toBe('third') // Third created
  })

  it('should fetch jobs with ignoreStartAfter in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    // Send a job scheduled for the future
    const futureDate = new Date(Date.now() + 60000) // 1 minute in future
    await ctx.boss.send(ctx.schema, { value: 'future' }, { startAfter: futureDate })

    // Normal fetch should return nothing (job is scheduled for future)
    const normalFetch = await ctx.boss.fetch(ctx.schema)
    expect(normalFetch.length).toBe(0)

    // Fetch with ignoreStartAfter should get the job
    const [job] = await ctx.boss.fetch<{ value: string }>(ctx.schema, { ignoreStartAfter: true })
    expect(job).toBeTruthy()
    expect(job.data.value).toBe('future')
  })

  it('should handle high concurrency without duplicates in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })
    const jobCount = 50
    const workerCount = 10

    // Send many jobs
    await Promise.all(
      Array.from({ length: jobCount }, (_, i) => ctx.boss!.send(ctx.schema, { index: i }))
    )

    // Simulate many concurrent workers fetching jobs
    const results = await Promise.all(
      Array.from({ length: workerCount }, () =>
        ctx.boss!.fetch(ctx.schema, { batchSize: jobCount })
      )
    )

    // Flatten all fetched jobs
    const allJobs = results.flat()

    // Verify no duplicates
    const jobIds = allJobs.map(j => j.id)
    const uniqueJobIds = new Set(jobIds)
    expect(uniqueJobIds.size).toBe(jobIds.length) // No duplicates

    // All jobs should eventually be claimed (may need multiple rounds under contention)
    // Due to concurrent contention, we may not get all jobs in one round
    expect(allJobs.length).toBeLessThanOrEqual(jobCount)
    expect(allJobs.length).toBeGreaterThan(0)

    // Track which job indices were claimed
    const claimedIndices = new Set(allJobs.map(j => (j.data as { index: number }).index))

    // Fetch remaining jobs
    let remainingJobs = await ctx.boss.fetch(ctx.schema, { batchSize: jobCount })
    while (remainingJobs.length > 0) {
      for (const job of remainingJobs) {
        const index = (job.data as { index: number }).index
        // Verify this job wasn't already claimed
        expect(claimedIndices.has(index)).toBe(false)
        claimedIndices.add(index)
      }
      remainingJobs = await ctx.boss.fetch(ctx.schema, { batchSize: jobCount })
    }

    // Verify all jobs were claimed exactly once
    expect(claimedIndices.size).toBe(jobCount)
  })

  it('should work with stately policy in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'stately', retryLimit: 2 })

    await ctx.boss.send(ctx.schema, { value: 1 })
    await ctx.boss.send(ctx.schema, { value: 2 })

    // First fetch should get a job
    const [job1] = await ctx.boss.fetch(ctx.schema)
    expect(job1).toBeTruthy()

    // Second fetch should get nothing (stately only allows 1 active)
    const [job2] = await ctx.boss.fetch(ctx.schema)
    expect(job2).toBeFalsy()

    // Fail the first job (goes to retry state)
    await ctx.boss.fail(ctx.schema, job1.id)

    // Job should be in retry state
    const jobData = await ctx.boss.getJobById(ctx.schema, job1.id)
    helper.assertTruthy(jobData)
    expect(jobData.state).toBe('retry')

    // Should be able to fetch the retry job (stately allows fetching retry jobs)
    const [job3] = await ctx.boss.fetch(ctx.schema)
    expect(job3).toBeTruthy()
    expect(job3.id).toBe(job1.id)
  })

  it('should work with singletonKey in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true, noDefault: true })

    // Create queue with singleton policy to enable singletonKey batch ranking
    await ctx.boss.createQueue(ctx.schema, { policy: 'singleton' })

    // Send jobs with different singleton keys
    await ctx.boss.send(ctx.schema, { value: 'a1' }, { singletonKey: 'key-a' })
    await ctx.boss.send(ctx.schema, { value: 'a2' }, { singletonKey: 'key-a' })
    await ctx.boss.send(ctx.schema, { value: 'b1' }, { singletonKey: 'key-b' })

    // Fetch with batchSize > 1 to trigger singleton ranking
    const jobs = await ctx.boss.fetch<{ value: string }>(ctx.schema, { batchSize: 10 })

    // Should get one job per singleton key (2 jobs total: one for key-a, one for key-b)
    expect(jobs.length).toBe(2)

    const values = jobs.map(j => j.data.value).sort()
    expect(values).toContain('a1') // First job with key-a
    expect(values).toContain('b1') // First job with key-b

    // Complete both jobs
    await ctx.boss.complete(ctx.schema, jobs[0].id)
    await ctx.boss.complete(ctx.schema, jobs[1].id)

    // Now should be able to fetch a2 (key-a is no longer active)
    const [nextJob] = await ctx.boss.fetch<{ value: string }>(ctx.schema)
    expect(nextJob).toBeTruthy()
    expect(nextJob.data.value).toBe('a2')
  })

  it('should work with group concurrency tiers in distributed mode', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, distributedDatabaseMode: true })

    // Send jobs with different group tiers
    await ctx.boss.send(ctx.schema, { value: 'std1' }, { group: { id: 'group1', tier: 'standard' } })
    await ctx.boss.send(ctx.schema, { value: 'std2' }, { group: { id: 'group1', tier: 'standard' } })
    await ctx.boss.send(ctx.schema, { value: 'std3' }, { group: { id: 'group1', tier: 'standard' } })
    await ctx.boss.send(ctx.schema, { value: 'prem1' }, { group: { id: 'group2', tier: 'premium' } })
    await ctx.boss.send(ctx.schema, { value: 'prem2' }, { group: { id: 'group2', tier: 'premium' } })
    await ctx.boss.send(ctx.schema, { value: 'prem3' }, { group: { id: 'group2', tier: 'premium' } })

    // Fetch with tiered group concurrency: standard=1, premium=2
    const jobs = await ctx.boss.fetch<{ value: string }>(ctx.schema, {
      batchSize: 10,
      groupConcurrency: {
        default: 1,
        tiers: { premium: 2 }
      }
    })

    // Should get 1 standard (group1) + 2 premium (group2) = 3 jobs
    expect(jobs.length).toBe(3)

    const values = jobs.map(j => j.data.value)
    expect(values.filter(v => v.startsWith('std')).length).toBe(1)
    expect(values.filter(v => v.startsWith('prem')).length).toBe(2)
  })
})
