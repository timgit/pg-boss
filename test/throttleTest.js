const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('throttle', function () {
  it('should only create 1 job for interval with a delay', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'delayThrottle'
    const singletonSeconds = 4
    const startAfter = 2
    const sendInterval = 200
    const sendCount = 5

    let processCount = 0

    boss.work(queue, async () => processCount++)

    for (let i = 0; i < sendCount; i++) {
      await boss.send(queue, null, { startAfter, singletonSeconds })
      await delay(sendInterval)
    }

    await delay(singletonSeconds * 1000)

    assert(processCount <= 2)
  })

  it('should process at most 1 job per second', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'throttle-1ps'
    const singletonSeconds = 1
    const jobCount = 3
    const sendInterval = 100
    const assertTimeout = jobCount * 1000

    const sendCount = 0
    let processCount = 0

    boss.work(queue, async () => processCount++)

    for (let i = 0; i < sendCount; i++) {
      await boss.send(queue, null, { singletonSeconds })
      await delay(sendInterval)
    }

    await delay(assertTimeout)

    assert(processCount <= jobCount + 1)
  })

  it('should debounce', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'debounce'

    const jobId = await boss.send(queue, null, { singletonHours: 1 })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonHours: 1, singletonNextSlot: true })

    assert(jobId2)
  })

  it('should debounce via sendDebounced()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'sendDebounced'
    const seconds = 60

    const jobId = await boss.sendDebounced(queue, null, null, seconds)

    assert(jobId)

    const jobId2 = await boss.sendDebounced(queue, null, null, seconds)

    assert(jobId2)

    const jobId3 = await boss.sendDebounced(queue, null, null, seconds)

    assert.strictEqual(jobId3, null)
  })

  it('should reject 2nd request in the same time slot', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'throttle-reject-2nd'

    const jobId1 = await boss.send(queue, null, { singletonHours: 1 })

    assert(jobId1)

    const jobId2 = await boss.send(queue, null, { singletonHours: 1 })

    assert.strictEqual(jobId2, null)
  })

  it('should throttle via sendThrottled()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'throttle-reject-2nd-sendThrottled'
    const seconds = 60

    const jobId1 = await boss.sendThrottled(queue, null, null, seconds)

    assert(jobId1)

    const jobId2 = await boss.sendThrottled(queue, null, null, seconds)

    assert.strictEqual(jobId2, null)
  })

  it('should log 4 jobs when called by 4 sendQueued()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'debounced-compile-4-jobs'
    const seconds = 60

    const jobId1 = await boss.sendQueued(queue, { job: 1 }, null, seconds, 'x')

    assert(jobId1)

    const jobId2 = await boss.sendQueued(queue, { job: 2 }, null, seconds, 'x')

    assert.notEqual(jobId2, null)

    const jobId3 = await boss.sendQueued(queue, { job: 3 }, null, seconds, 'x')

    assert.notEqual(jobId3, null)

    const jobId4 = await boss.sendQueued(queue, { job: 4 }, null, seconds, 'x')

    assert.notEqual(jobId4, null)
  })
})
