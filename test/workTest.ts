import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import * as helper from './testHelper.ts'

describe('work', function () {
  it('should fail with no arguments', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      await this.boss.work()
    })
  })

  it('should fail if no callback provided', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      await this.boss.work('foo')
    })
  })

  it('should fail if options is not an object', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      await this.boss.work('foo', async () => {}, 'nope')
    })
  })

  it('offWork should fail without a name', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      await this.boss.offWork()
    })
  })

  it('should honor a custom polling interval', async function () {
    this.boss = await helper.start(this.bossConfig)

    const pollingIntervalSeconds = 1
    const timeout = 5000
    let processCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await this.boss.send(this.schema)
    }

    await this.boss.work(this.schema, { pollingIntervalSeconds }, async () => {
      processCount++
    })

    await delay(timeout)

    assert.strictEqual(processCount, timeout / 1000 / pollingIntervalSeconds)
  })

  it('should provide abort signal to job handler', async function () {
    this.boss = await helper.start(this.bossConfig)

    let receivedSignal

    await this.boss.send(this.schema)

    await this.boss.work(this.schema, async ([job]) => {
      receivedSignal = job.signal
    })

    await delay(1000)

    assert(receivedSignal instanceof AbortSignal)
  })

  it('should honor when a worker is notified', async function () {
    this.boss = await helper.start(this.bossConfig)

    let processCount = 0

    await this.boss.send(this.schema)

    const workerId = await this.boss.work(this.schema, { pollingIntervalSeconds: 5 }, async () => processCount++)

    await delay(500)

    assert.strictEqual(processCount, 1)

    await this.boss.send(this.schema)

    this.boss.notifyWorker(workerId)

    await delay(500)

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
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema)

    await new Promise((resolve) => {
      this.boss!.work(this.schema, { batchSize: 1 }, async jobs => {
        assert.strictEqual(jobs.length, 1)
        resolve()
      })
    })

    await delay(500)

    const job = await this.boss.getJobById(this.schema, jobId!)

    assert.strictEqual(job!.state, 'completed')
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
    this.boss = await helper.start(this.bossConfig)

    const result = 'success'

    const jobId = await this.boss.send(this.schema)

    await this.boss.work(this.schema, async () => result)

    await delay(1000)

    const job = await this.boss.getJobById(this.schema, jobId!)

    assert.strictEqual(job!.state, 'completed')
    assert.strictEqual(job!.output.value, result)
  })

  it('handler result should be stored in output', async function () {
    this.boss = await helper.start(this.bossConfig)
    const something = 'clever'

    const jobId = await this.boss.send(this.schema)
    await this.boss.work(this.schema, async () => ({ something }))

    await delay(1000)

    const job = await this.boss.getJobById(this.schema, jobId!)

    assert.strictEqual(job!.state, 'completed')
    assert.strictEqual(job!.output.something, something)
  })

  it('job cab be deleted in handler', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema)
    await this.boss.work(this.schema, async ([job]) => this.boss.deleteJob(this.schema, job.id))

    await delay(1000)

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
    assert(job!.output!.message!.includes('handler execution exceeded'))
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
    assert(job1!.output.message.includes('handler execution exceeded'))

    assert.strictEqual(job2!.state, 'failed')
    assert(job2!.output.message.includes('handler execution exceeded'))
  })

  it('should emit wip event every 2s for workers', async function () {
    this.boss = await helper.start(this.bossConfig)

    const firstWipEvent = new Promise(resolve => this.boss!.once('wip', resolve))

    await this.boss.send(this.schema)

    await this.boss.work(this.schema, { pollingIntervalSeconds: 1 }, () => delay(2000))

    const wip1 = await firstWipEvent

    await this.boss.send(this.schema)

    assert.strictEqual(wip1.length, 1)

    const secondWipEvent = new Promise(resolve => this.boss!.once('wip', resolve))

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
