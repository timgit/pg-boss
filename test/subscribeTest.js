const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')
const PgBoss = require('../')

describe('subscribe', function () {
  it('should fail with no arguments', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.subscribe()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if no callback provided', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.subscribe('foo')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if options is not an object', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.subscribe('foo', () => {}, 'nope')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('unsubscribe should fail without a name', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.unsubscribe()
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
    let subscribeCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await boss.publish(queue)
    }

    await boss.subscribe(queue, { newJobCheckIntervalSeconds }, () => subscribeCount++)

    await delay(timeout)

    assert.strictEqual(subscribeCount, timeout / 1000 / newJobCheckIntervalSeconds)
  })

  it('should unsubscribe a subscription', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'unsubscribe-works'

    let receivedCount = 0

    boss.subscribe(queue, async () => {
      receivedCount++
      await boss.unsubscribe(queue)
    })

    await boss.publish(queue)
    await boss.publish(queue)

    await delay(5000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should unsubscribe a subscription by id', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let receivedCount = 0

    await boss.publish(queue)
    await boss.publish(queue)

    const id = await boss.subscribe(queue, { newJobCheckInterval: 500 }, async () => {
      receivedCount++
      await boss.unsubscribe({ id })
    })

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should handle a batch of jobs via teamSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'subscribe-teamSize'
    const teamSize = 4

    let subscribeCount = 0

    for (let i = 0; i < teamSize; i++) {
      await boss.publish(queue)
    }

    return new Promise((resolve, reject) => {
      boss.subscribe(queue, { teamSize }, async () => {
        subscribeCount++

        // test would time out if it had to wait for 4 fetch intervals
        if (subscribeCount === teamSize) {
          resolve()
        }
      }).catch(reject)
    })
  })

  it('should apply teamConcurrency option', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'subscribe-teamConcurrency'
    const teamSize = 4
    const teamConcurrency = 4

    let subscribeCount = 0

    for (let i = 0; i < teamSize; i++) {
      await boss.publish(queue)
    }

    return new Promise((resolve) => {
      boss.subscribe(queue, { teamSize, teamConcurrency }, async () => {
        subscribeCount++

        if (subscribeCount === teamSize) {
          resolve()
        }

        // test would time out if it had to wait for each handler to resolve
        await delay(4000)
      })
    })
  })

  it('should handle a batch of jobs via batchSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'subscribe-batchSize'
    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await boss.publish(queue)
    }

    return new Promise((resolve) => {
      boss.subscribe(queue, { batchSize }, async jobs => {
        assert.strictEqual(jobs.length, batchSize)
        resolve()
      })
    })
  })

  it('returning promise applies backpressure', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'backpressure'

    const batchSize = 4
    let subscribeCount = 0

    for (let i = 0; i < batchSize; i++) {
      await boss.publish(queue)
    }

    await boss.subscribe(queue, async () => {
      // delay slows down subscribe fetch
      await delay(2000)
      subscribeCount++
    })

    await delay(7000)

    assert(subscribeCount < batchSize)
  })

  it('top up jobs when at one job in team is still running', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    this.timeout(1000)

    const queue = 'subscribe-teamConcurrency-topup'
    const teamSize = 4
    const teamConcurrency = 2

    let subscribeCount = 0

    for (let i = 0; i < 6; i++) {
      await boss.publish(queue)
    }

    const newJobCheckInterval = 100

    return new Promise((resolve) => {
      boss.subscribe(queue, { teamSize, teamConcurrency, newJobCheckInterval }, async () => {
        subscribeCount++
        if (subscribeCount === 1) {
          // Test would timeout if all were blocked on this first
          // process
          await new Promise(resolve => setTimeout(resolve, 500))
          return
        }

        if (subscribeCount === 6) {
          resolve()
        }
      })
    })
  })

  it('does not fetch more than teamSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'teamSize-topup-limit'
    const teamSize = 4
    const teamConcurrency = 2
    const newJobCheckInterval = 200
    let subscribeCount = 0
    let remainCount = 0

    for (let i = 0; i < 7; i++) {
      await boss.publish(queue)
    }

    // This should consume 5 jobs, all will block after the first job
    await boss.subscribe(queue, { teamSize, teamConcurrency, newJobCheckInterval }, async () => {
      subscribeCount++
      if (subscribeCount > 1) await new Promise(resolve => setTimeout(resolve, 1000))
    })

    await new Promise(resolve => setTimeout(resolve, 400))

    // If the above hasn't over subscribed, this should pick up the last 2 jobs
    await boss.subscribe(queue, { teamSize, teamConcurrency, newJobCheckInterval }, async () => {
      remainCount++
    })

    await new Promise(resolve => setTimeout(resolve, 400))

    assert(remainCount === 2)
  })

  it('should have a done callback for single job subscriptions', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'subscribe-single'

    await boss.publish(queue)

    return new Promise((resolve) => {
      boss.subscribe(queue, async job => {
        job.done()
        resolve()
      })
    })
  })

  it('subscribe completion should pass string wrapped in value prop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'subscribeCompletionString'
    const result = 'success'

    boss.subscribe(queue, async job => result)

    await boss.publish(queue)

    await delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'completed')
    assert.strictEqual(job.data.response.value, result)
  })

  it('subscribe completion via Promise resolve() should pass object payload', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'subscribeCompletionObject'
    const something = 'clever'

    boss.subscribe(queue, async job => ({ something }))

    await boss.publish(queue)

    await delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'completed')
    assert.strictEqual(job.data.response.something, something)
  })

  it('should allow multiple subscriptions to the same queue per instance', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'multiple-subscriptions'

    await boss.subscribe(queue, () => {})
    await boss.subscribe(queue, () => {})
  })

  it('should honor the includeMetadata option', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'subscribe-includeMetadata'

    await boss.publish(queue)

    return new Promise((resolve) => {
      boss.subscribe(queue, { includeMetadata: true }, async job => {
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

    const jobId = await boss.publish(queue, null, { expireInSeconds: 1 })

    await boss.subscribe(queue, () => delay(2000))

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

    const jobId1 = await boss.publish(queue, null, { expireInSeconds: 1 })
    const jobId2 = await boss.publish(queue, null, { expireInSeconds: 1 })

    await boss.subscribe(queue, { batchSize: 2 }, () => delay(2000))

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

    await boss.publish(queue)
    await boss.subscribe(queue, () => delay(1000))

    const wip1 = await firstWipEvent

    assert.strictEqual(wip1.length, 1)

    const secondWipEvent = new Promise(resolve => boss.once('wip', resolve))

    const wip2 = await secondWipEvent

    assert.strictEqual(wip2.length, 0)
  })

  it('should reject subscribe() after stopping', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    boss.stop({ timeout: 1 })

    try {
      await boss.subscribe(queue)
      assert(false)
    } catch (err) {
      assert(err.message.includes('stopping'))
    }
  })
})
