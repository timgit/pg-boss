const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('throttle', function () {
  it('should only create 1 job for interval with a delay', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'delayThrottle'
    const singletonSeconds = 4
    const startAfter = 2
    const publishInterval = 200
    const publishCount = 5

    let subscribeCount = 0

    boss.subscribe(queue, async () => subscribeCount++)

    for (let i = 0; i < publishCount; i++) {
      await boss.publish(queue, null, { startAfter, singletonSeconds })
      await delay(publishInterval)
    }

    await delay(singletonSeconds * 1000)

    assert(subscribeCount <= 2)
  })

  it('should process at most 1 job per second', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'throttle-1ps'
    const singletonSeconds = 1
    const jobCount = 3
    const publishInterval = 100
    const assertTimeout = jobCount * 1000

    const publishCount = 0
    let subscribeCount = 0

    boss.subscribe(queue, async () => subscribeCount++)

    for (let i = 0; i < publishCount; i++) {
      await boss.publish(queue, null, { singletonSeconds })
      await delay(publishInterval)
    }

    await delay(assertTimeout)

    assert(subscribeCount <= jobCount + 1)
  })

  it('should debounce', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'debounce'

    const jobId = await boss.publish(queue, null, { singletonHours: 1 })

    assert(jobId)

    const jobId2 = await boss.publish(queue, null, { singletonHours: 1, singletonNextSlot: true })

    assert(jobId2)
  })

  it('should debounce via publishDebounced()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'publishDebounced'
    const seconds = 60

    const jobId = await boss.publishDebounced(queue, null, null, seconds)

    assert(jobId)

    const jobId2 = await boss.publishDebounced(queue, null, null, seconds)

    assert(jobId2)

    const jobId3 = await boss.publishDebounced(queue, null, null, seconds)

    assert.strictEqual(jobId3, null)
  })

  it('should reject 2nd request in the same time slot', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'throttle-reject-2nd'

    const jobId1 = await boss.publish(queue, null, { singletonHours: 1 })

    assert(jobId1)

    const jobId2 = await boss.publish(queue, null, { singletonHours: 1 })

    assert.strictEqual(jobId2, null)
  })

  it('should throttle via publishThrottled()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'throttle-reject-2nd-publishThrottled'
    const seconds = 60

    const jobId1 = await boss.publishThrottled(queue, null, null, seconds)

    assert(jobId1)

    const jobId2 = await boss.publishThrottled(queue, null, null, seconds)

    assert.strictEqual(jobId2, null)
  })
})
