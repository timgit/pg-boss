import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('spy', function () {
  it('should track job creation', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    const job = await spy.waitForJobWithId(jobId!, 'created')

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.name, testContext.schema)
    assert.deepStrictEqual(job.data, { value: 'test' })
    assert.strictEqual(job.state, 'created')
  })

  it('should track job completion', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    await testContext.boss.work(testContext.schema, async () => ({ result: 'success' }))

    const job = await spy.waitForJobWithId(jobId!, 'completed')

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.state, 'completed')
    assert.deepStrictEqual(job.output, { result: 'success' })
  })

  it('should track job failure', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'test' })

    await testContext.boss.work(testContext.schema, async () => {
      throw new Error('test error')
    })

    const job = await spy.waitForJobWithId(jobId!, 'failed')

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.state, 'failed')
    assert.strictEqual((job.output as any).message, 'test error')
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

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.state, 'active')
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

    assert.strictEqual(job.id, jobId)
    assert(duration < 100, 'Should resolve immediately for already-tracked job')
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

    assert.deepStrictEqual(job.data, { value: 'second' })
    assert.strictEqual(job.state, 'completed')
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

    assert.deepStrictEqual(job.data, { value: 'awaited' })
    assert.strictEqual(job.state, 'completed')
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

    assert.strictEqual(job1.id, jobId1)
    assert.strictEqual(job2.id, jobId2)
    assert.deepStrictEqual(job1.data, { value: 'job1' })
    assert.deepStrictEqual(job2.data, { value: 'job2' })
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

    assert.strictEqual(result, 'timeout', 'Should timeout since data was cleared')
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

    assert.deepStrictEqual(jobs[0].data, { value: 'bulk1' })
    assert.deepStrictEqual(jobs[1].data, { value: 'bulk2' })
    assert.deepStrictEqual(jobs[2].data, { value: 'bulk3' })
  })

  it('should protect against data mutation', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy<{ value: string }>(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema, { value: 'original' })

    const job1 = await spy.waitForJobWithId(jobId!, 'created')
    job1.data.value = 'mutated'

    const job2 = await spy.waitForJobWithId(jobId!, 'created')

    assert.strictEqual(job2.data.value, 'original', 'Data should be cloned and protected from mutation')
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

    assert.deepStrictEqual(jobA.data, { queue: 'A' })
    assert.deepStrictEqual(jobB.data, { queue: 'B' })
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

    assert.strictEqual(result, 'timeout', 'Should timeout since spies were cleared')
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

    assert.deepStrictEqual(job.data, { value: 'race-test' })
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

    assert.strictEqual(jobs.length, batchSize)
    for (const job of jobs) {
      assert.strictEqual(job.state, 'completed')
    }
  })

  it('should throw error when spy is not enabled', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    assert.throws(
      () => testContext.boss!.getSpy(testContext.schema),
      /Spy is not enabled/
    )
  })

  it('should track job creation via singletonNextSlot retry path', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)

    // First job creates the singleton slot
    const jobId1 = await testContext.boss.send(testContext.schema, { value: 'first' }, { singletonSeconds: 300 })
    assert.ok(jobId1)

    const job1 = await spy.waitForJobWithId(jobId1!, 'created')
    assert.strictEqual(job1.id, jobId1)

    // Second job with singletonNextSlot triggers the retry path (try2)
    // because the first insert conflicts with the existing singleton
    const jobId2 = await testContext.boss.send(testContext.schema, { value: 'second' }, { singletonSeconds: 300, singletonNextSlot: true })
    assert.ok(jobId2)

    const job2 = await spy.waitForJobWithId(jobId2!, 'created')
    assert.strictEqual(job2.id, jobId2)
    assert.deepStrictEqual(job2.data, { value: 'second' })
  })
})
