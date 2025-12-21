import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('throttle', function () {
  it('should only create 1 job for interval', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const singletonSeconds = 2
    const sendCount = 4

    for (let i = 0; i < sendCount; i++) {
      await testContext.boss.send(testContext.schema, null, { singletonSeconds })
      await delay(1000)
    }

    const { length } = await testContext.boss.fetch(testContext.schema, { batchSize: sendCount })

    assert(length < sendCount)
  })

  it('should process at most 1 job per second', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const singletonSeconds = 1
    const jobCount = 3
    const sendInterval = 100
    const assertTimeout = jobCount * 1000

    const sendCount = 0
    let processCount = 0

    testContext.boss.work(testContext.schema, async () => processCount++)

    for (let i = 0; i < sendCount; i++) {
      await testContext.boss.send(testContext.schema, null, { singletonSeconds })
      await delay(sendInterval)
    }

    await delay(assertTimeout)

    assert(processCount <= jobCount + 1)
  })

  it('should debounce', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema, null, { singletonSeconds: 300 })

    assert(jobId)

    const jobId2 = await testContext.boss.send(testContext.schema, null, { singletonSeconds: 300, singletonNextSlot: true })

    assert(jobId2)
  })

  it('should debounce via sendDebounced()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const seconds = 60

    const jobId = await testContext.boss.sendDebounced(testContext.schema, null, null, seconds)

    assert(jobId)

    const jobId2 = await testContext.boss.sendDebounced(testContext.schema, null, null, seconds)

    assert(jobId2)

    const jobId3 = await testContext.boss.sendDebounced(testContext.schema, null, null, seconds)

    assert.strictEqual(jobId3, null)
  })

  it('should reject 2nd request in the same time slot', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId1 = await testContext.boss.send(testContext.schema, null, { singletonSeconds: 300 })

    assert(jobId1)

    const jobId2 = await testContext.boss.send(testContext.schema, null, { singletonSeconds: 300 })

    assert.strictEqual(jobId2, null)
  })

  it('should throttle via sendThrottled()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const seconds = 60

    const jobId1 = await testContext.boss.sendThrottled(testContext.schema, null, null, seconds)

    assert(jobId1)

    const jobId2 = await testContext.boss.sendThrottled(testContext.schema, null, null, seconds)

    assert.strictEqual(jobId2, null)
  })

  it('should not allow more than 1 complete job with the same key with an interval', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const singletonKey = 'a'
    const singletonSeconds = 60

    await testContext.boss.send(testContext.schema, null, { singletonKey, singletonSeconds })
    const [job] = await testContext.boss.fetch(testContext.schema)

    await testContext.boss.complete(testContext.schema, job.id)

    const jobId = await testContext.boss.send(testContext.schema, null, { singletonKey, singletonSeconds })

    assert.strictEqual(jobId, null)
  })
})
