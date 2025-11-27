import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import * as helper from './testHelper.ts'

describe('spy', function () {
  it('should track job creation', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'test' })

    const job = await spy.waitForJobWithId(jobId!, 'created')

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.name, this.schema)
    assert.deepStrictEqual(job.data, { value: 'test' })
    assert.strictEqual(job.state, 'created')
  })

  it('should track job completion', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'test' })

    await this.boss.work(this.schema, async () => ({ result: 'success' }))

    const job = await spy.waitForJobWithId(jobId!, 'completed')

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.state, 'completed')
    assert.deepStrictEqual(job.output, { result: 'success' })
  })

  it('should track job failure', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'test' })

    await this.boss.work(this.schema, async () => {
      throw new Error('test error')
    })

    const job = await spy.waitForJobWithId(jobId!, 'failed')

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.state, 'failed')
    assert.strictEqual(job.output!.message, 'test error')
  })

  it('should track job as active', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'test' })

    let resolveWorker!: () => void
    const workerBlocked = new Promise<void>(resolve => { resolveWorker = resolve })

    await this.boss.work(this.schema, async () => {
      resolveWorker()
      await delay(1000)
    })

    await workerBlocked

    const job = await spy.waitForJobWithId(jobId!, 'active')

    assert.strictEqual(job.id, jobId)
    assert.strictEqual(job.state, 'active')
  })

  it('should resolve immediately if job already in requested state', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'test' })

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
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy<{ value: string }>(this.schema)

    await this.boss.send(this.schema, { value: 'first' })
    await this.boss.send(this.schema, { value: 'second' })

    await this.boss.work(this.schema, async () => {})

    const job = await spy.waitForJob(
      (data) => data.value === 'second',
      'completed'
    )

    assert.deepStrictEqual(job.data, { value: 'second' })
    assert.strictEqual(job.state, 'completed')
  })

  it('should await job that completes after calling waitForJob', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy<{ value: string }>(this.schema)

    // Start waiting before job exists
    const waitPromise = spy.waitForJob(
      (data) => data.value === 'awaited',
      'completed'
    )

    // Send and process job after
    await this.boss.send(this.schema, { value: 'awaited' })
    await this.boss.work(this.schema, async () => {})

    const job = await waitPromise

    assert.deepStrictEqual(job.data, { value: 'awaited' })
    assert.strictEqual(job.state, 'completed')
  })

  it('should track multiple jobs independently', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId1 = await this.boss.send(this.schema, { value: 'job1' })
    const jobId2 = await this.boss.send(this.schema, { value: 'job2' })

    await this.boss.work(this.schema, async () => {})

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
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'test' })

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
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy<{ value: string }>(this.schema)

    // Use explicit IDs for bulk insert
    const { randomUUID } = await import('node:crypto')
    const id1 = randomUUID()
    const id2 = randomUUID()
    const id3 = randomUUID()

    await this.boss.insert(this.schema, [
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
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy<{ value: string }>(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'original' })

    const job1 = await spy.waitForJobWithId(jobId!, 'created')
    job1.data.value = 'mutated'

    const job2 = await spy.waitForJobWithId(jobId!, 'created')

    assert.strictEqual(job2.data.value, 'original', 'Data should be cloned and protected from mutation')
  })

  it('should work with separate spies per queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const queueA = this.schema + '_a'
    const queueB = this.schema + '_b'

    await this.boss.createQueue(queueA)
    await this.boss.createQueue(queueB)

    const spyA = this.boss.getSpy(queueA)
    const spyB = this.boss.getSpy(queueB)

    const jobIdA = await this.boss.send(queueA, { queue: 'A' })
    const jobIdB = await this.boss.send(queueB, { queue: 'B' })

    const jobA = await spyA.waitForJobWithId(jobIdA!, 'created')
    const jobB = await spyB.waitForJobWithId(jobIdB!, 'created')

    assert.deepStrictEqual(jobA.data, { queue: 'A' })
    assert.deepStrictEqual(jobB.data, { queue: 'B' })
  })

  it('should clearSpies on boss instance', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema, { value: 'test' })

    await spy.waitForJobWithId(jobId!, 'created')

    this.boss.clearSpies()

    // After clearSpies, getting spy again should return a fresh one
    const newSpy = this.boss.getSpy(this.schema)

    const timeoutPromise = Promise.race([
      newSpy.waitForJobWithId(jobId!, 'created'),
      delay(500).then(() => 'timeout')
    ])

    const result = await timeoutPromise

    assert.strictEqual(result, 'timeout', 'Should timeout since spies were cleared')
  })

  it('should handle race condition - await before job creation', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy<{ value: string }>(this.schema)

    // Start awaiting before job is even created
    const waitPromise = spy.waitForJob(
      (data) => data.value === 'race-test',
      'created'
    )

    await this.boss.send(this.schema, { value: 'race-test' })

    const job = await waitPromise

    assert.deepStrictEqual(job.data, { value: 'race-test' })
  })

  it('should handle batch processing with spy', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    const batchSize = 3

    const jobIds: string[] = []
    for (let i = 0; i < batchSize; i++) {
      const id = await this.boss.send(this.schema, { index: i })
      jobIds.push(id!)
    }

    await this.boss.work(this.schema, { batchSize }, async () => {
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
    this.boss = await helper.start(this.bossConfig)

    assert.throws(
      () => this.boss.getSpy(this.schema),
      /Spy is not enabled/
    )
  })
})
