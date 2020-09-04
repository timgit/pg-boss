const Promise = require('bluebird')
const assert = require('assert')
const helper = require('./testHelper')

describe('subscribe', function () {
  it('should fail with no arguments', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.subscribe()
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should fail if no callback provided', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.subscribe('foo')
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should fail if options is not an object', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.subscribe('foo', () => {}, 'nope')
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('unsubscribe should fail without a name', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.unsubscribe()
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should honor a custom new job check interval', async function () {
    const queue = 'customJobCheckInterval'
    const newJobCheckIntervalSeconds = 3
    const timeout = 9000
    let subscribeCount = 0
    const jobCount = 10

    const boss = await helper.start(this.test.bossConfig)

    for (let i = 0; i < jobCount; i++) {
      await boss.publish(queue)
    }

    await boss.subscribe(queue, { newJobCheckIntervalSeconds }, () => subscribeCount++)

    await Promise.delay(timeout)

    assert(subscribeCount <= timeout / 1000 / newJobCheckIntervalSeconds)

    await boss.stop()
  })

  it('should unsubscribe a subscription', async function () {
    const queue = 'unsubscribe-works'

    let receivedCount = 0

    const boss = await helper.start(this.test.bossConfig)

    boss.subscribe(queue, async () => {
      receivedCount++
      await boss.unsubscribe(queue)
    })

    await boss.publish(queue)
    await boss.publish(queue)

    await Promise.delay(5000)

    assert.strictEqual(receivedCount, 1)

    await boss.stop()
  })

  it('should handle a batch of jobs via teamSize', async function () {
    this.timeout(1000)

    const queue = 'subscribe-teamSize'
    const teamSize = 4

    let subscribeCount = 0

    const boss = await helper.start(this.test.bossConfig)

    for (let i = 0; i < teamSize; i++) {
      await boss.publish(queue)
    }

    return new Promise((resolve, reject) => {
      boss.subscribe(queue, { teamSize }, async () => {
        subscribeCount++

        // test would time out if it had to wait for 4 fetch intervals
        if (subscribeCount === teamSize) {
          await boss.stop()
          resolve()
        }
      }).catch(reject)
    })
  })

  it('should apply teamConcurrency option', function (finished) {
    this.timeout(1000)

    const queue = 'subscribe-teamConcurrency'
    const teamSize = 4
    const teamConcurrency = 4

    let subscribeCount = 0

    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)

      for (let i = 0; i < teamSize; i++) {
        await boss.publish(queue)
      }

      boss.subscribe(queue, { teamSize, teamConcurrency }, async () => {
        subscribeCount++

        if (subscribeCount === teamSize) {
          await boss.stop()
          finished()
        }

        // test would time out if it had to wait for each handler to resolve
        await Promise.delay(4000)
      })
    }
  })

  it('teamConcurrency allows for fetching more jobs when one blocks', function (finished) {
    this.timeout(1000)

    const queue = 'subscribe-teamConcurrency-topup'
    const teamSize = 4
    const teamConcurrency = 2

    let subscribeCount = 0

    const config = this.test.bossConfig

    test().catch(finished)

    async function test () {
      const boss = await helper.start(config)

      for (let i = 0; i < 6; i++) {
        await boss.publish(queue)
      }

      const newJobCheckInterval = 100

      await boss.subscribe(queue, { teamSize, teamConcurrency, newJobCheckInterval }, async () => {
        subscribeCount++
        if (subscribeCount === 1) {
          // Test would timeout if all were blocked on this first
          // process
          await Promise.delay(4000)
          return
        }

        if (subscribeCount === 6) {
          await boss.stop()
          finished()
        }
      })
    }
  })

  it('should handle a batch of jobs via batchSize', function (finished) {
    const queue = 'subscribe-batchSize'
    const batchSize = 4

    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)

      for (let i = 0; i < batchSize; i++) {
        await boss.publish(queue)
      }

      boss.subscribe(queue, { batchSize }, async jobs => {
        assert.strictEqual(jobs.length, batchSize)
        await boss.stop()
        finished()
      }).catch(finished)
    }
  })

  it('returning promise applies backpressure', async function () {
    const queue = 'backpressure'
    const batchSize = 4
    let subscribeCount = 0

    const boss = await helper.start(this.test.bossConfig)

    for (let i = 0; i < batchSize; i++) {
      await boss.publish(queue)
    }

    await boss.subscribe(queue, async () => {
      // delay slows down subscribe fetch
      await Promise.delay(2000)
      subscribeCount++
    })

    await Promise.delay(7000)

    assert(subscribeCount < batchSize)

    await boss.stop()
  })

  it('does not fetch more than teamSize', async function () {
    const queue = 'teamSize-topup-limit'
    const teamSize = 4
    const teamConcurrency = 2
    const newJobCheckInterval = 500
    let subscribeCount = 0
    let remainCount = 0

    const boss = await helper.start(this.test.bossConfig)

    for (let i = 0; i < 7; i++) {
      await boss.publish(queue)
    }

    // This should consume 5 jobs, all will block after the first job
    await boss.subscribe(queue, { teamSize, teamConcurrency, newJobCheckInterval }, async () => {
      subscribeCount++
      if (subscribeCount > 1) await Promise.delay(4000)
    })

    await Promise.delay(1000)

    // If the above hasn't over subscribed, this should pick up the last 2 jobs
    await boss.subscribe(queue, { teamSize, teamConcurrency, newJobCheckInterval }, async () => {
      remainCount++
    })

    await Promise.delay(1000)

    assert(remainCount === 2)

    await boss.stop()
  })

  it('should have a done callback for single job subscriptions', function (finished) {
    const queue = 'subscribe-single'

    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)
      await boss.publish(queue)

      boss.subscribe(queue, async job => {
        await job.done()
        await boss.stop()
        finished()
      })
    }
  })

  it('subscribe completion should pass string wrapped in value prop', function (finished) {
    const queue = 'subscribeCompletionString'
    const result = 'success'

    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)

      boss.subscribe(queue, async job => result)

      await boss.publish(queue)

      await Promise.delay(8000)

      const job = await boss.fetchCompleted(queue)

      assert.strictEqual(job.data.state, 'completed')
      assert.strictEqual(job.data.response.value, result)

      await boss.stop()

      finished()
    }
  })

  it('subscribe completion via Promise resolve() should pass object payload', function (finished) {
    const queue = 'subscribeCompletionObject'
    const something = 'clever'

    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)

      boss.subscribe(queue, async job => ({ something }))

      await boss.publish(queue)

      await Promise.delay(8000)

      const job = await boss.fetchCompleted(queue)

      assert.strictEqual(job.data.state, 'completed')
      assert.strictEqual(job.data.response.something, something)

      await boss.stop()

      finished()
    }
  })

  it('should allow multiple subscriptions to the same queue per instance', async function () {
    const queue = 'multiple-subscriptions'

    const boss = await helper.start(this.test.bossConfig)

    await boss.subscribe(queue, () => {})
    await boss.subscribe(queue, () => {})

    await boss.stop()
  })

  it('should honor the includeMetadata option', function (finished) {
    const queue = 'subscribe-includeMetadata'

    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)

      await boss.publish(queue)

      boss.subscribe(queue, { includeMetadata: true }, async job => {
        assert(job.startedon !== undefined)
        await boss.stop()
        finished()
      }).catch(finished)
    }
  })
})
