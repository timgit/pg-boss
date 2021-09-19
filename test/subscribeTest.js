const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')
const PgBoss = require('../')

describe('process', function () {
  it('should fail with no arguments', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.process()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if no callback provided', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.process('foo')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if options is not an object', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.process('foo', () => {}, 'nope')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('unprocess should fail without a name', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.unprocess()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should honor a custom new job check interval', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const newJobCheckIntervalSeconds = 1
    const timeout = 5000
    let processCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await boss.send(queue)
    }

    await boss.process(queue, { newJobCheckIntervalSeconds }, () => processCount++)

    await delay(timeout)

    assert.strictEqual(processCount, timeout / 1000 / newJobCheckIntervalSeconds)
  })

  it('should unprocess a subscription', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'unprocess-works'

    let receivedCount = 0

    boss.process(queue, async () => {
      receivedCount++
      await boss.unprocess(queue)
    })

    await boss.send(queue)
    await boss.send(queue)

    await delay(5000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should unprocess a subscription by id', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let receivedCount = 0

    await boss.send(queue)
    await boss.send(queue)

    const id = await boss.process(queue, { newJobCheckInterval: 500 }, async () => {
      receivedCount++
      await boss.unprocess({ id })
    })

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should handle a batch of jobs via teamSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-teamSize'
    const teamSize = 4

    let processCount = 0

    for (let i = 0; i < teamSize; i++) {
      await boss.send(queue)
    }

    return new Promise((resolve, reject) => {
      boss.process(queue, { teamSize }, async () => {
        processCount++

        // test would time out if it had to wait for 4 fetch intervals
        if (processCount === teamSize) {
          resolve()
        }
      }).catch(reject)
    })
  })

  it('should apply teamConcurrency option', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-teamConcurrency'
    const teamSize = 4
    const teamConcurrency = 4

    let processCount = 0

    for (let i = 0; i < teamSize; i++) {
      await boss.send(queue)
    }

    return new Promise((resolve) => {
      boss.process(queue, { teamSize, teamConcurrency }, async () => {
        processCount++

        if (processCount === teamSize) {
          resolve()
        }

        // test would time out if it had to wait for each handler to resolve
        await delay(4000)
      })
    })
  })

  it('should handle a batch of jobs via batchSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-batchSize'
    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await boss.send(queue)
    }

    return new Promise((resolve) => {
      boss.process(queue, { batchSize }, async jobs => {
        assert.strictEqual(jobs.length, batchSize)
        resolve()
      })
    })
  })

  it('returning promise applies backpressure', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'backpressure'

    const batchSize = 4
    let processCount = 0

    for (let i = 0; i < batchSize; i++) {
      await boss.send(queue)
    }

    await boss.process(queue, async () => {
      // delay slows down process fetch
      await delay(2000)
      processCount++
    })

    await delay(7000)

    assert(processCount < batchSize)
  })

  it('should have a done callback for single job subscriptions', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'process-single'

    await boss.send(queue)

    return new Promise((resolve) => {
      boss.process(queue, async job => {
        job.done()
        resolve()
      })
    })
  })

  it('process completion should pass string wrapped in value prop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'processCompletionString'
    const result = 'success'

    boss.process(queue, async job => result)

    await boss.send(queue)

    await delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'completed')
    assert.strictEqual(job.data.response.value, result)
  })

  it('process completion via Promise resolve() should pass object payload', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'processCompletionObject'
    const something = 'clever'

    boss.process(queue, async job => ({ something }))

    await boss.send(queue)

    await delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'completed')
    assert.strictEqual(job.data.response.something, something)
  })

  it('should allow multiple subscriptions to the same queue per instance', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'multiple-subscriptions'

    await boss.process(queue, () => {})
    await boss.process(queue, () => {})
  })

  it('should honor the includeMetadata option', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-includeMetadata'

    await boss.send(queue)

    return new Promise((resolve) => {
      boss.process(queue, { includeMetadata: true }, async job => {
        assert(job.startedon !== undefined)
        resolve()
      })
    })
  })

  it('should fail job at expiration without maintenance', async function () {
    const boss = this.test.boss = new PgBoss(this.test.bossConfig)

    boss.on('error', err => console.log(err))

    const maintenanceTick = new Promise((resolve) => boss.on('maintenance', resolve))

    await boss.start()

    await maintenanceTick

    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { expireInSeconds: 1 })

    await boss.process(queue, () => delay(2000))

    await delay(2000)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.state, 'failed')
    assert(job.output.message.includes('handler execution exceeded'))
  })

  it('should fail a batch of jobs at expiration without maintenance', async function () {
    const boss = this.test.boss = new PgBoss(this.test.bossConfig)

    boss.on('error', err => console.log(err))

    const maintenanceTick = new Promise((resolve) => boss.on('maintenance', resolve))

    await boss.start()

    await maintenanceTick

    const queue = this.test.bossConfig.schema

    const jobId1 = await boss.send(queue, null, { expireInSeconds: 1 })
    const jobId2 = await boss.send(queue, null, { expireInSeconds: 1 })

    await boss.process(queue, { batchSize: 2 }, () => delay(2000))

    await delay(2000)

    const job1 = await boss.getJobById(jobId1)
    const job2 = await boss.getJobById(jobId2)

    assert.strictEqual(job1.state, 'failed')
    assert(job1.output.message.includes('handler execution exceeded'))

    assert.strictEqual(job2.state, 'failed')
    assert(job2.output.message.includes('handler execution exceeded'))
  })

  it('should emit wip event every 2s during subscriptions', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const firstWipEvent = new Promise(resolve => boss.once('wip', resolve))

    await boss.send(queue)
    await boss.process(queue, () => delay(1000))

    const wip1 = await firstWipEvent

    assert.strictEqual(wip1.length, 1)

    const secondWipEvent = new Promise(resolve => boss.once('wip', resolve))

    const wip2 = await secondWipEvent

    assert.strictEqual(wip2.length, 0)
  })

  it('should reject process() after stopping', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    boss.stop({ timeout: 1 })

    try {
      await boss.process(queue)
      assert(false)
    } catch (err) {
      assert(err.message.includes('stopping'))
    }
  })
})
