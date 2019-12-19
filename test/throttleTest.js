const assert = require('chai').assert
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('throttle', function () {
  this.timeout(10000)

  let boss

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('should only create 1 job for interval with a delay', async function () {
    const queue = 'delayThrottle'
    const singletonSeconds = 4
    const startAfter = 2
    const publishInterval = 200
    const publishCount = 5

    let subscribeCount = 0

    boss.subscribe(queue, async () => subscribeCount++)

    for (let i = 0; i < publishCount; i++) {
      await boss.publish(queue, null, { startAfter, singletonSeconds })
      await Promise.delay(publishInterval)
    }

    await Promise.delay(singletonSeconds * 1000)

    assert.isAtMost(subscribeCount, 2)
  })

  it('should process at most 1 job per second', async function () {
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
      await Promise.delay(publishInterval)
    }

    await Promise.delay(assertTimeout)

    assert.isAtMost(subscribeCount, jobCount + 1)
  })

  it('should debounce', async function () {
    const queue = 'debounce'

    const jobId = await boss.publish(queue, null, { singletonHours: 1 })

    assert.isOk(jobId)

    const jobId2 = await boss.publish(queue, null, { singletonHours: 1, singletonNextSlot: true })

    assert.isOk(jobId2)
  })

  it('should debounce via publishDebounced()', async function () {
    const queue = 'publishDebounced'
    const seconds = 60

    const jobId = await boss.publishDebounced(queue, null, null, seconds)

    assert.isOk(jobId)

    const jobId2 = await boss.publishDebounced(queue, null, null, seconds)

    assert.isOk(jobId2)

    const jobId3 = await boss.publishDebounced(queue, null, null, seconds)

    assert.isNotOk(jobId3)
  })

  it('should reject 2nd request in the same time slot', async function () {
    const queue = 'throttle-reject-2nd'

    const jobId1 = await boss.publish(queue, null, { singletonHours: 1 })

    assert.isOk(jobId1)

    const jobId2 = await boss.publish(queue, null, { singletonHours: 1 })

    assert.isNotOk(jobId2)
  })

  it('should throttle via publishThrottled()', async function () {
    const queue = 'throttle-reject-2nd-publishThrottled'
    const seconds = 60

    const jobId1 = await boss.publishThrottled(queue, null, null, seconds)

    assert.isOk(jobId1)

    const jobId2 = await boss.publishThrottled(queue, null, null, seconds)

    assert.isNotOk(jobId2)
  })
})
