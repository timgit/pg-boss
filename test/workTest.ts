import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('work', function () {
  it('should fail with no arguments', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.work()
    })
  })

  it('should fail if no callback provided', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.work('foo')
    })
  })

  it('should fail if options is not an object', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.work('foo', async () => {}, 'nope')
    })
  })

  it('offWork should fail without a name', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.offWork()
    })
  })

  it('should honor a custom polling interval', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    const pollingIntervalSeconds = 1
    let processCount = 0
    const expectedProcessCount = 5

    const jobIds: string[] = []
    for (let i = 0; i < expectedProcessCount; i++) {
      const jobId = await testContext.boss.send(testContext.schema)
      jobIds.push(jobId!)
    }

    await testContext.boss.work(testContext.schema, { pollingIntervalSeconds }, async () => {
      processCount++
    })

    // Wait for all jobs to complete
    await Promise.all(jobIds.map(id => spy.waitForJobWithId(id, 'completed')))

    assert.strictEqual(processCount, expectedProcessCount)
  })

  it('should provide abort signal to job handler', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    let receivedSignal = {}

    const jobId = await testContext.boss.send(testContext.schema)

    await testContext.boss.work(testContext.schema, async ([job]) => {
      receivedSignal = job.signal
    })

    await spy.waitForJobWithId(jobId!, 'completed')

    assert(receivedSignal instanceof AbortSignal)
  })

  it('should honor when a worker is notified', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    let processCount = 0

    const jobId1 = await testContext.boss.send(testContext.schema)

    const workerId = await testContext.boss.work(testContext.schema, { pollingIntervalSeconds: 5 }, async () => processCount++)

    await spy.waitForJobWithId(jobId1!, 'completed')

    assert.strictEqual(processCount, 1)

    const jobId2 = await testContext.boss.send(testContext.schema)

    testContext.boss.notifyWorker(workerId)

    await spy.waitForJobWithId(jobId2!, 'completed')

    assert.strictEqual(processCount, 2)
  })

  it('should remove a worker', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    let receivedCount = 0

    testContext.boss.work(testContext.schema, async () => {
      receivedCount++
      await testContext.boss!.offWork(testContext.schema)
    })

    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)

    await delay(5000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should remove a worker by id', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    let receivedCount = 0

    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)

    const id = await testContext.boss.work(testContext.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      receivedCount++
      await testContext.boss!.offWork(testContext.schema, { id })
    })

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should handle a batch of jobs via batchSize', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await testContext.boss.send(testContext.schema)
    }

    return new Promise<void>((resolve) => {
      testContext.boss!.work(testContext.schema, { batchSize }, async jobs => {
        assert.strictEqual(jobs.length, batchSize)
        resolve()
      })
    })
  })

  it('batchSize should auto-complete the jobs', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    const jobId = await testContext.boss.send(testContext.schema)

    await testContext.boss.work(testContext.schema, { batchSize: 1 }, async jobs => {
      assert.strictEqual(jobs.length, 1)
    })

    const job = await spy.waitForJobWithId(jobId!, 'completed')

    assert.strictEqual(job.state, 'completed')
  })

  it('returning promise applies backpressure', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobCount = 4
    let processCount = 0

    for (let i = 0; i < jobCount; i++) {
      await testContext.boss.send(testContext.schema)
    }

    await testContext.boss.work(testContext.schema, async () => {
      // delay slows down process fetch
      await delay(2000)
      processCount++
    })

    await delay(7000)

    assert(processCount < jobCount)
  })

  it('completion should pass string wrapped in value prop', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    const result = 'success'

    const jobId = await testContext.boss.send(testContext.schema)

    await testContext.boss.work(testContext.schema, async () => result)

    await spy.waitForJobWithId(jobId!, 'completed')

    const job = await testContext.boss.getJobById(testContext.schema, jobId!)

    assert.strictEqual(job!.state, 'completed')
    assert.strictEqual((job!.output as { value: string }).value, result)
  })

  it('handler result should be stored in output', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = testContext.boss.getSpy(testContext.schema)

    const jobId = await testContext.boss.send(testContext.schema)
    await testContext.boss.work(testContext.schema, async () => ({ something }))

    const job = await spy.waitForJobWithId(jobId!, 'completed')

    assert.strictEqual(job.state, 'completed')
    assert.strictEqual((job.output as { something: string }).something, something)
  })

  it('job can be deleted in handler', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    const jobId = await testContext.boss.send(testContext.schema)

    assert(jobId)

    await testContext.boss.work(testContext.schema, async ([job]) => testContext.boss!.deleteJob(testContext.schema, job.id))

    await spy.waitForJobWithId(jobId, 'completed')

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert(!job)
  })

  it('should allow multiple workers to the same testContext.schema per instance', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.work(testContext.schema, async () => {})
    await testContext.boss.work(testContext.schema, async () => {})
  })

  it('should honor the includeMetadata option', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)

    return new Promise<void>((resolve) => {
      testContext.boss!.work(testContext.schema, { includeMetadata: true }, async ([job]) => {
        assert(job.startedOn !== undefined)
        resolve()
      })
    })
  })

  it('should fail job at expiration in worker', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, supervise: false })

    const jobId = await testContext.boss.send(testContext.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await testContext.boss.work(testContext.schema, () => delay(2000))

    await delay(2000)

    const job = await testContext.boss.getJobById(testContext.schema, jobId!)

    assert.strictEqual(job!.state, 'failed')
    assert((job!.output as any).message!.includes('handler execution exceeded'))
  })

  it('should fail a batch of jobs at expiration in worker', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, supervise: false })

    const jobId1 = await testContext.boss.send(testContext.schema, null, { retryLimit: 0, expireInSeconds: 1 })
    const jobId2 = await testContext.boss.send(testContext.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await testContext.boss.work(testContext.schema, { batchSize: 2 }, () => delay(2000))

    await delay(2000)

    const job1 = await testContext.boss.getJobById(testContext.schema, jobId1!)
    const job2 = await testContext.boss.getJobById(testContext.schema, jobId2!)

    assert.strictEqual(job1!.state, 'failed')
    assert((job1!.output as any).message.includes('handler execution exceeded'))

    assert.strictEqual(job2!.state, 'failed')
    assert((job2!.output as any).message.includes('handler execution exceeded'))
  })

  it('should emit wip event every 2s for workers', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const firstWipEvent = new Promise<Array<any>>(resolve => testContext.boss!.once('wip', resolve))

    await testContext.boss.send(testContext.schema)

    await testContext.boss.work(testContext.schema, { pollingIntervalSeconds: 1 }, () => delay(2000))

    const wip1 = await firstWipEvent

    await testContext.boss.send(testContext.schema)

    assert.strictEqual(wip1.length, 1)

    const secondWipEvent = new Promise<Array<any>>(resolve => testContext.boss!.once('wip', resolve))

    const wip2 = await secondWipEvent

    assert.strictEqual(wip2.length, 1)
  })

  it('should reject work() after stopping', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.stop()

    await assert.rejects(async () => {
      await testContext.boss!.work(testContext.schema, async () => {})
    })
  })

  it('should allow send() after stopping', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    testContext.boss.stop({ close: false })

    await testContext.boss.send(testContext.schema)
  })
})
