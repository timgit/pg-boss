const { delay } = require('../src/tools')
const assert = require('node:assert')
const helper = require('./testHelper')

describe('work', function () {
  it('should fail with no arguments', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.work()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if no callback provided', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.work('foo')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if options is not an object', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.work('foo', () => {}, 'nope')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('offWork should fail without a name', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.offWork()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should honor a custom polling interval', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const pollingIntervalSeconds = 1
    const timeout = 5000
    let processCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await boss.send(queue)
    }

    await boss.work(queue, { pollingIntervalSeconds }, () => processCount++)

    await delay(timeout)

    assert.strictEqual(processCount, timeout / 1000 / pollingIntervalSeconds)
  })

  it('should honor when a worker is notified', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let processCount = 0

    await boss.send(queue)

    const workerId = await boss.work(queue, { pollingIntervalSeconds: 5 }, () => processCount++)

    await delay(500)

    assert.strictEqual(processCount, 1)

    await boss.send(queue)

    boss.notifyWorker(workerId)

    await delay(500)

    assert.strictEqual(processCount, 2)
  })

  it('should remove a worker', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let receivedCount = 0

    boss.work(queue, async () => {
      receivedCount++
      await boss.offWork(queue)
    })

    await boss.send(queue)
    await boss.send(queue)

    await delay(5000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should remove a worker by id', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let receivedCount = 0

    await boss.send(queue)
    await boss.send(queue)

    const id = await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async () => {
      receivedCount++
      await boss.offWork({ id })
    })

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should handle a batch of jobs via batchSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await boss.send(queue)
    }

    return new Promise((resolve) => {
      boss.work(queue, { batchSize }, async jobs => {
        assert.strictEqual(jobs.length, batchSize)
        resolve()
      })
    })
  })

  it('batchSize should auto-complete the jobs', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    await new Promise((resolve) => {
      boss.work(queue, { batchSize: 1 }, async jobs => {
        assert.strictEqual(jobs.length, 1)
        resolve()
      })
    })

    await delay(500)

    const job = await boss.getJobById(queue, jobId)

    assert.strictEqual(job.state, 'completed')
  })

  it('returning promise applies backpressure', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const jobCount = 4
    let processCount = 0

    for (let i = 0; i < jobCount; i++) {
      await boss.send(queue)
    }

    await boss.work(queue, async () => {
      // delay slows down process fetch
      await delay(2000)
      processCount++
    })

    await delay(7000)

    assert(processCount < jobCount)
  })

  it('completion should pass string wrapped in value prop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const result = 'success'

    const jobId = await boss.send(queue)

    await boss.work(queue, async () => result)

    await delay(1000)

    const job = await boss.getJobById(queue, jobId)

    assert.strictEqual(job.state, 'completed')
    assert.strictEqual(job.output.value, result)
  })

  it('handler result should be stored in output', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema
    const something = 'clever'

    const jobId = await boss.send(queue)
    await boss.work(queue, async () => ({ something }))

    await delay(1000)

    const job = await boss.getJobById(queue, jobId)

    assert.strictEqual(job.state, 'completed')
    assert.strictEqual(job.output.something, something)
  })

  it('job cab be deleted in handler', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)
    await boss.work(queue, async ([job]) => boss.deleteJob(queue, job.id))

    await delay(1000)

    const job = await boss.getJobById(queue, jobId)

    assert(!job)
  })

  it('should allow multiple workers to the same queue per instance', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.work(queue, () => {})
    await boss.work(queue, () => {})
  })

  it('should honor the includeMetadata option', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    return new Promise((resolve) => {
      boss.work(queue, { includeMetadata: true }, async ([job]) => {
        assert(job.startedOn !== undefined)
        resolve()
      })
    })
  })

  it('should fail job at expiration in worker', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, supervise: false })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { expireInSeconds: 1 })

    await boss.work(queue, () => delay(2000))

    await delay(2000)

    const job = await boss.getJobById(queue, jobId)

    assert.strictEqual(job.state, 'failed')
    assert(job.output.message.includes('handler execution exceeded'))
  })

  it('should fail a batch of jobs at expiration in worker', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, supervise: false })
    const queue = this.test.bossConfig.schema

    const jobId1 = await boss.send(queue, null, { expireInSeconds: 1 })
    const jobId2 = await boss.send(queue, null, { expireInSeconds: 1 })

    await boss.work(queue, { batchSize: 2 }, () => delay(2000))

    await delay(2000)

    const job1 = await boss.getJobById(queue, jobId1)
    const job2 = await boss.getJobById(queue, jobId2)

    assert.strictEqual(job1.state, 'failed')
    assert(job1.output.message.includes('handler execution exceeded'))

    assert.strictEqual(job2.state, 'failed')
    assert(job2.output.message.includes('handler execution exceeded'))
  })

  it('should emit wip event every 2s for workers', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const firstWipEvent = new Promise(resolve => boss.once('wip', resolve))

    await boss.send(queue)

    await boss.work(queue, { pollingIntervalSeconds: 1 }, () => delay(2000))

    const wip1 = await firstWipEvent

    await boss.send(queue)

    assert.strictEqual(wip1.length, 1)

    const secondWipEvent = new Promise(resolve => boss.once('wip', resolve))

    const wip2 = await secondWipEvent

    assert.strictEqual(wip2.length, 1)
  })

  it('should reject work() after stopping', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.stop({ wait: true })

    try {
      await boss.work(queue, () => {})
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should allow send() after stopping', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    boss.stop({ wait: true, close: false })

    await boss.send(queue)
  })
})
