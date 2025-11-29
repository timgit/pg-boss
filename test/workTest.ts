import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('work', function () {
  it('should fail with no arguments', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await this.boss.work()
    })
  })

  it('should fail if no callback provided', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await this.boss.work('foo')
    })
  })

  it('should fail if options is not an object', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await this.boss.work('foo', async () => {}, 'nope')
    })
  })

  it('offWork should fail without a name', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await this.boss.offWork()
    })
  })

  it('should honor a custom polling interval', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    const pollingIntervalSeconds = 1
    let processCount = 0
    const expectedProcessCount = 5

    const jobIds: string[] = []
    for (let i = 0; i < expectedProcessCount; i++) {
      const jobId = await this.boss.send(this.schema)
      jobIds.push(jobId!)
    }

    await this.boss.work(this.schema, { pollingIntervalSeconds }, async () => {
      processCount++
    })

    // Wait for all jobs to complete
    await Promise.all(jobIds.map(id => spy.waitForJobWithId(id, 'completed')))

    assert.strictEqual(processCount, expectedProcessCount)
  })

  it('should provide abort signal to job handler', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    let receivedSignal = {}

    const jobId = await this.boss.send(this.schema)

    await this.boss.work(this.schema, async ([job]) => {
      receivedSignal = job.signal
    })

    await spy.waitForJobWithId(jobId!, 'completed')

    assert(receivedSignal instanceof AbortSignal)
  })

  it('should honor when a worker is notified', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    let processCount = 0

    const jobId1 = await this.boss.send(this.schema)

    const workerId = await this.boss.work(this.schema, { pollingIntervalSeconds: 5 }, async () => processCount++)

    await spy.waitForJobWithId(jobId1!, 'completed')

    assert.strictEqual(processCount, 1)

    const jobId2 = await this.boss.send(this.schema)

    this.boss.notifyWorker(workerId)

    await spy.waitForJobWithId(jobId2!, 'completed')

    assert.strictEqual(processCount, 2)
  })

  it('should remove a worker', async function () {
    this.boss = await helper.start(this.bossConfig)

    let receivedCount = 0

    this.boss.work(this.schema, async () => {
      receivedCount++
      await this.boss!.offWork(this.schema)
    })

    await this.boss.send(this.schema)
    await this.boss.send(this.schema)

    await delay(5000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should remove a worker by id', async function () {
    this.boss = await helper.start(this.bossConfig)

    let receivedCount = 0

    await this.boss.send(this.schema)
    await this.boss.send(this.schema)

    const id = await this.boss.work(this.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      receivedCount++
      await this.boss!.offWork(this.schema, { id })
    })

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should handle a batch of jobs via batchSize', async function () {
    this.boss = await helper.start(this.bossConfig)

    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await this.boss.send(this.schema)
    }

    return new Promise((resolve) => {
      this.boss!.work(this.schema, { batchSize }, async jobs => {
        assert.strictEqual(jobs.length, batchSize)
        resolve()
      })
    })
  })

  it('batchSize should auto-complete the jobs', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    const jobId = await this.boss.send(this.schema)

    await this.boss.work(this.schema, { batchSize: 1 }, async jobs => {
      assert.strictEqual(jobs.length, 1)
    })

    const job = await spy.waitForJobWithId(jobId!, 'completed')

    assert.strictEqual(job.state, 'completed')
  })

  it('returning promise applies backpressure', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobCount = 4
    let processCount = 0

    for (let i = 0; i < jobCount; i++) {
      await this.boss.send(this.schema)
    }

    await this.boss.work(this.schema, async () => {
      // delay slows down process fetch
      await delay(2000)
      processCount++
    })

    await delay(7000)

    assert(processCount < jobCount)
  })

  it('completion should pass string wrapped in value prop', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    const result = 'success'

    const jobId = await this.boss.send(this.schema)

    await this.boss.work(this.schema, async () => result)

    await spy.waitForJobWithId(jobId!, 'completed')

    const job = await this.boss.getJobById(this.schema, jobId!)

    assert.strictEqual(job!.state, 'completed')
    assert.strictEqual((job!.output as { value: string }).value, result)
  })

  it('handler result should be stored in output', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = this.boss.getSpy(this.schema)

    const jobId = await this.boss.send(this.schema)
    await this.boss.work(this.schema, async () => ({ something }))

    const job = await spy.waitForJobWithId(jobId!, 'completed')

    assert.strictEqual(job.state, 'completed')
    assert.strictEqual((job.output as { something: string }).something, something)
  })

  it('job can be deleted in handler', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    await this.boss.work(this.schema, async ([job]) => this.boss!.deleteJob(this.schema, job.id))

    await spy.waitForJobWithId(jobId, 'completed')

    const job = await this.boss.getJobById(this.schema, jobId)

    assert(!job)
  })

  it('should allow multiple workers to the same this.schema per instance', async function () {
    this.boss = await helper.start(this.bossConfig)

    await this.boss.work(this.schema, async () => {})
    await this.boss.work(this.schema, async () => {})
  })

  it('should honor the includeMetadata option', async function () {
    this.boss = await helper.start(this.bossConfig)

    await this.boss.send(this.schema)

    return new Promise((resolve) => {
      this.boss!.work(this.schema, { includeMetadata: true }, async ([job]) => {
        assert(job.startedOn !== undefined)
        resolve()
      })
    })
  })

  it('should fail job at expiration in worker', async function () {
    this.boss = await helper.start({ ...this.bossConfig, supervise: false })

    const jobId = await this.boss.send(this.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await this.boss.work(this.schema, () => delay(2000))

    await delay(2000)

    const job = await this.boss.getJobById(this.schema, jobId!)

    assert.strictEqual(job!.state, 'failed')
    assert((job!.output as any).message!.includes('handler execution exceeded'))
  })

  it('should fail a batch of jobs at expiration in worker', async function () {
    this.boss = await helper.start({ ...this.bossConfig, supervise: false })

    const jobId1 = await this.boss.send(this.schema, null, { retryLimit: 0, expireInSeconds: 1 })
    const jobId2 = await this.boss.send(this.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    await this.boss.work(this.schema, { batchSize: 2 }, () => delay(2000))

    await delay(2000)

    const job1 = await this.boss.getJobById(this.schema, jobId1!)
    const job2 = await this.boss.getJobById(this.schema, jobId2!)

    assert.strictEqual(job1!.state, 'failed')
    assert((job1!.output as any).message.includes('handler execution exceeded'))

    assert.strictEqual(job2!.state, 'failed')
    assert((job2!.output as any).message.includes('handler execution exceeded'))
  })

  it('should emit wip event every 2s for workers', async function () {
    this.boss = await helper.start(this.bossConfig)

    const firstWipEvent = new Promise<Array<any>>(resolve => this.boss!.once('wip', resolve))

    await this.boss.send(this.schema)

    await this.boss.work(this.schema, { pollingIntervalSeconds: 1 }, () => delay(2000))

    const wip1 = await firstWipEvent

    await this.boss.send(this.schema)

    assert.strictEqual(wip1.length, 1)

    const secondWipEvent = new Promise<Array<any>>(resolve => this.boss!.once('wip', resolve))

    const wip2 = await secondWipEvent

    assert.strictEqual(wip2.length, 1)
  })

  it('should reject work() after stopping', async function () {
    this.boss = await helper.start(this.bossConfig)

    await this.boss.stop()

    await assert.rejects(async () => {
      await this.boss!.work(this.schema, async () => {})
    })
  })

  it('should allow send() after stopping', async function () {
    this.boss = await helper.start(this.bossConfig)

    this.boss.stop({ close: false })

    await this.boss.send(this.schema)
  })
})
