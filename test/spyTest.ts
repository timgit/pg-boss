import { delay } from '../src/tools.ts'
import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('spy', function () {
  it('should track job creation', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    const job = await spy.waitForJobWithId(jobId!, 'created')

    expect(job.id).toBe(jobId)
    expect(job.name).toBe(testContext.schema)
    expect(job.data).toEqual({ value: 'test' })
    expect(job.state).toBe('created')
  })

  it('should track job completion', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    await testContext.boss.work(testContext.schema, async () => ({ result: 'success' }))

    const job = await spy.waitForJobWithId(jobId!, 'completed')

    expect(job.id).toBe(jobId)
    expect(job.state).toBe('completed')
    expect(job.output).toEqual({ result: 'success' })
  })

  it('should track job failure', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    await testContext.boss.work(testContext.schema, async () => {
      throw new Error('test error')
    })

    const job = await spy.waitForJobWithId(jobId!, 'failed')

    expect(job.id).toBe(jobId)
    expect(job.state).toBe('failed')
    expect((job.output as any).message).toBe('test error')
  })

  it('should track job as active', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    let resolveWorker!: () => void
    const workerBlocked = new Promise<void>(resolve => { resolveWorker = resolve })

    await testContext.boss.work(testContext.schema, async () => {
      resolveWorker()
      await delay(1000)
    })

    await workerBlocked

    const job = await spy.waitForJobWithId(jobId!, 'active')

    expect(job.id).toBe(jobId)
    expect(job.state).toBe('active')
  })

  it('should resolve immediately if job already in requested state', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    // Wait for job to be created first
    await spy.waitForJobWithId(jobId!, 'created')

    // Now request the same state again - should resolve immediately
    const start = Date.now()
    const job = await spy.waitForJobWithId(jobId!, 'created')
    const duration = Date.now() - start

    expect(job.id).toBe(jobId)
    expect(duration < 100).toBeTruthy()
  })

  it('should support waitForJob with data selector', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy<{ value: string }>(testContext.schema)

    await testContext.boss.send(testContext.schema, { value: 'first' })
    await testContext.boss.send(testContext.schema, { value: 'second' })

    await testContext.boss.work(testContext.schema, async () => {})

    const job = await spy.waitForJob(
      (data) => data.value === 'second',
      'completed'
    )

    expect(job.data).toEqual({ value: 'second' })
    expect(job.state).toBe('completed')
  })

  it('should await job that completes after calling waitForJob', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy<{ value: string }>(testContext.schema)

    // Start waiting before job exists
    const waitPromise = spy.waitForJob(
      (data) => data.value === 'awaited',
      'completed'
    )

    // Send and process job after
    await testContext.boss.send(testContext.schema, { value: 'awaited' })
    await testContext.boss.work(testContext.schema, async () => {})

    const job = await waitPromise

    expect(job.data).toEqual({ value: 'awaited' })
    expect(job.state).toBe('completed')
  })

  it('should track multiple jobs independently', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId1 = await testContext.boss.send(testContext.schema, { value: 'job1' })
    const jobId2 = await testContext.boss.send(testContext.schema, { value: 'job2' })

    await testContext.boss.work(testContext.schema, async () => {})

    const [job1, job2] = await Promise.all([
      spy.waitForJobWithId(jobId1!, 'completed'),
      spy.waitForJobWithId(jobId2!, 'completed')
    ])

    expect(job1.id).toBe(jobId1)
    expect(job2.id).toBe(jobId2)
    expect(job1.data).toEqual({ value: 'job1' })
    expect(job2.data).toEqual({ value: 'job2' })
  })

  it('should clear spy data', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    await spy.waitForJobWithId(jobId!, 'created')

    spy.clear()

    // Start waiting for a job that will never arrive (cleared data)
    const timeoutPromise = Promise.race([
      spy.waitForJobWithId(jobId!, 'created'),
      delay(500).then(() => 'timeout')
    ])

    const result = await timeoutPromise

    expect(result).toBe('timeout')
  })

  it('should work with insert (bulk send)', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy<{ value: string }>(testContext.schema)

    // Use explicit IDs for bulk insert
    const { randomUUID } = await import('node:crypto')
    const id1 = randomUUID()
    const id2 = randomUUID()
    const id3 = randomUUID()

    await testContext.boss.insert(testContext.schema, [
      { id: id1, data: { value: 'bulk1' } },
      { id: id2, data: { value: 'bulk2' } },
      { id: id3, data: { value: 'bulk3' } }
    ])

    // All jobs should be tracked as created
    const jobs = await Promise.all([
      spy.waitForJobWithId(id1, 'created'),
      spy.waitForJobWithId(id2, 'created'),
      spy.waitForJobWithId(id3, 'created')
    ])

    expect(jobs[0].data).toEqual({ value: 'bulk1' })
    expect(jobs[1].data).toEqual({ value: 'bulk2' })
    expect(jobs[2].data).toEqual({ value: 'bulk3' })
  })

  it('should protect against data mutation', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy<{ value: string }>(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'original' })

    const job1 = await spy.waitForJobWithId(jobId!, 'created')
    job1.data.value = 'mutated'

    const job2 = await spy.waitForJobWithId(jobId!, 'created')

    expect(job2.data.value).toBe('original')
  })

  it('should work with separate spies per queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const queueA = testContext.schema + '_a'
    const queueB = testContext.schema + '_b'

    await testContext.boss.createQueue(queueA)
    await testContext.boss.createQueue(queueB)

    const spyA = testContext.boss.getSpy(queueA)
    const spyB = testContext.boss.getSpy(queueB)

    const jobIdA = await testContext.boss.send(queueA, { queue: 'A' })
    const jobIdB = await testContext.boss.send(queueB, { queue: 'B' })

    const jobA = await spyA.waitForJobWithId(jobIdA!, 'created')
    const jobB = await spyB.waitForJobWithId(jobIdB!, 'created')

    expect(jobA.data).toEqual({ queue: 'A' })
    expect(jobB.data).toEqual({ queue: 'B' })
  })

  it('should clearSpies on boss instance', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    await spy.waitForJobWithId(jobId!, 'created')

    testContext.boss.clearSpies()

    // After clearSpies, getting spy again should return a fresh one
    const newSpy = testContext.boss.getSpy(testContext.schema)

    const timeoutPromise = Promise.race([
      newSpy.waitForJobWithId(jobId!, 'created'),
      delay(500).then(() => 'timeout')
    ])

    const result = await timeoutPromise

    expect(result).toBe('timeout')
  })

  it('should handle race condition - await before job creation', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy<{ value: string }>(testContext.schema)

    // Start awaiting before job is even created
    const waitPromise = spy.waitForJob(
      (data) => data.value === 'race-test',
      'created'
    )

    await testContext.boss.send(testContext.schema, { value: 'race-test' })

    const job = await waitPromise

    expect(job.data).toEqual({ value: 'race-test' })
  })

  it('should handle batch processing with spy', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    const batchSize = 3

    const jobIds: string[] = []
    for (let i = 0; i < batchSize; i++) {
      const id = await testContext.boss.send(testContext.schema, { index: i })
      jobIds.push(id!)
    }

    await testContext.boss.work(testContext.schema, { batchSize }, async () => {
      return { batch: true }
    })

    // All jobs should complete
    const jobs = await Promise.all(
      jobIds.map(id => spy.waitForJobWithId(id, 'completed'))
    )

    expect(jobs.length).toBe(batchSize)
    for (const job of jobs) {
      expect(job.state).toBe('completed')
    }
  })

  it('should throw error when spy is not enabled', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    expect(
      () => testContext.boss!.getSpy(testContext.schema)
    ).toThrow(/Spy is not enabled/)
  })

  it('should track job creation via singletonNextSlot retry path', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    // First job creates the singleton slot
    const jobId1 = await testContext.boss.send(testContext.schema, { value: 'first' }, { singletonSeconds: 300 })
    expect(jobId1).toBeTruthy()

    const job1 = await spy.waitForJobWithId(jobId1!, 'created')
    expect(job1.id).toBe(jobId1)

    // Second job with singletonNextSlot triggers the retry path (try2)
    // because the first insert conflicts with the existing singleton
    const jobId2 = await testContext.boss.send(testContext.schema, { value: 'second' }, { singletonSeconds: 300, singletonNextSlot: true })
    expect(jobId2).toBeTruthy()

    const job2 = await spy.waitForJobWithId(jobId2!, 'created')
    expect(job2.id).toBe(jobId2)
    expect(job2.data).toEqual({ value: 'second' })
  })
})
