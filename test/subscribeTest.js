const Promise = require('bluebird')
const assert = require('chai').assert
const helper = require('./testHelper')

describe('subscribe', function () {
  this.timeout(10000)
  let boss

  before(async function () { boss = await helper.start() })
  after(async function () { await boss.stop() })

  it('should fail with no arguments', function (finished) {
    boss.subscribe().catch(() => finished())
  })

  it('should fail if no callback provided', function (finished) {
    boss.subscribe('foo').catch(() => finished())
  })

  it('should fail if options is not an object', function (finished) {
    boss.subscribe('foo', () => {}, 'nope').catch(() => finished())
  })

  it('unsubscribe should fail without a name', function (finished) {
    boss.unsubscribe().catch(() => finished())
  })

  it('should honor a custom new job check interval', async function () {
    const queue = 'customJobCheckInterval'
    const newJobCheckIntervalSeconds = 3
    const timeout = 9000
    let subscribeCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await boss.publish(queue)
    }

    await boss.subscribe(queue, { newJobCheckIntervalSeconds }, () => subscribeCount++)

    await Promise.delay(timeout)

    assert.isAtMost(subscribeCount, timeout / 1000 / newJobCheckIntervalSeconds)
  })

  it('should unsubscribe a subscription', async function () {
    const queue = 'unsubscribe-works'

    let receivedCount = 0

    boss.subscribe(queue, async () => {
      receivedCount++
      await boss.unsubscribe(queue)
    })

    await boss.publish(queue)
    await boss.publish(queue)

    await Promise.delay(2000)

    assert.equal(receivedCount, 1)
  })

  it('should handle a batch of jobs via teamSize', function (finished) {
    this.timeout(1000)

    const queue = 'subscribe-teamSize'
    const teamSize = 4

    let subscribeCount = 0

    test()

    async function test () {
      for (let i = 0; i < teamSize; i++) {
        await boss.publish(queue)
      }

      boss.subscribe(queue, { teamSize }, async () => {
        subscribeCount++

        // test would time out if it had to wait for 4 fetch intervals
        if (subscribeCount === teamSize) {
          finished()
        }
      })
    }
  })

  it('should apply teamConcurrency option', function (finished) {
    this.timeout(1000)

    const queue = 'subscribe-teamConcurrency'
    const teamSize = 4
    const teamConcurrency = 4

    let subscribeCount = 0

    test()

    async function test () {
      for (let i = 0; i < teamSize; i++) {
        await boss.publish(queue)
      }

      boss.subscribe(queue, { teamSize, teamConcurrency }, async () => {
        subscribeCount++

        if (subscribeCount === teamSize) {
          finished()
        }

        // test would time out if it had to wait for each handler to resolve
        await Promise.delay(4000)
      })
    }
  })

  it('should handle a batch of jobs via batchSize', function (finished) {
    const queue = 'subscribe-batchSize'
    const batchSize = 4

    test()

    async function test () {
      for (let i = 0; i < batchSize; i++) {
        await boss.publish(queue)
      }

      boss.subscribe(queue, { batchSize }, jobs => {
        assert.equal(jobs.length, batchSize)
        finished()
      })
    }
  })

  it('returning promise applies backpressure', async function () {
    const queue = 'backpressure'
    const batchSize = 4
    let subscribeCount = 0

    for (let i = 0; i < batchSize; i++) {
      await boss.publish(queue)
    }

    boss.subscribe(queue, async () => {
      // delay slows down subscribe fetch
      await Promise.delay(2000)
      subscribeCount++
    })

    await Promise.delay(7000)

    assert.isBelow(subscribeCount, batchSize)
  })

  it('should have a done callback for single job subscriptions', function (finished) {
    const queue = 'subscribe-single'

    test()

    async function test () {
      await boss.publish(queue)

      boss.subscribe(queue, async job => {
        await job.done()
        finished()
      })
    }
  })

  it('subscribe completion should pass string wrapped in value prop', function (finished) {
    const queue = 'subscribeCompletionString'
    const result = 'success'

    test()

    async function test () {
      boss.subscribe(queue, async job => result)

      await boss.publish(queue)

      await Promise.delay(8000)

      const job = await boss.fetchCompleted(queue)

      assert.strictEqual(job.data.state, 'completed')
      assert.strictEqual(job.data.response.value, result)

      finished()
    }
  })

  it('subscribe completion via Promise resolve() should pass object payload', function (finished) {
    const queue = 'subscribeCompletionObject'
    const something = 'clever'

    test()

    async function test () {
      boss.subscribe(queue, async job => ({ something }))

      await boss.publish(queue)

      await Promise.delay(8000)

      const job = await boss.fetchCompleted(queue)

      assert.strictEqual(job.data.state, 'completed')
      assert.strictEqual(job.data.response.something, something)

      finished()
    }
  })

  it('should allow multiple subscriptions to the same queue per instance', async function () {
    const queue = 'multiple-subscriptions'

    await boss.subscribe(queue, () => {})
    await boss.subscribe(queue, () => {})
  })
})
