import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('throttle', function () {
  it('should only create 1 job for interval', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const singletonSeconds = 2
    const sendCount = 4

    for (let i = 0; i < sendCount; i++) {
      await this.boss.send(this.schema, null, { singletonSeconds })
      await delay(1000)
    }

    const { length } = await this.boss.fetch(this.schema, { batchSize: sendCount })

    assert(length < sendCount)
  })

  it('should process at most 1 job per second', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const singletonSeconds = 1
    const jobCount = 3
    const sendInterval = 100
    const assertTimeout = jobCount * 1000

    const sendCount = 0
    let processCount = 0

    this.boss.work(this.schema, async () => processCount++)

    for (let i = 0; i < sendCount; i++) {
      await this.boss.send(this.schema, null, { singletonSeconds })
      await delay(sendInterval)
    }

    await delay(assertTimeout)

    assert(processCount <= jobCount + 1)
  })

  it('should debounce', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const jobId = await this.boss.send(this.schema, null, { singletonSeconds: 300 })

    assert(jobId)

    const jobId2 = await this.boss.send(this.schema, null, { singletonSeconds: 300, singletonNextSlot: true })

    assert(jobId2)
  })

  it('should debounce via sendDebounced()', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const seconds = 60

    const jobId = await this.boss.sendDebounced(this.schema, null, null, seconds)

    assert(jobId)

    const jobId2 = await this.boss.sendDebounced(this.schema, null, null, seconds)

    assert(jobId2)

    const jobId3 = await this.boss.sendDebounced(this.schema, null, null, seconds)

    assert.strictEqual(jobId3, null)
  })

  it('should reject 2nd request in the same time slot', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const jobId1 = await this.boss.send(this.schema, null, { singletonSeconds: 300 })

    assert(jobId1)

    const jobId2 = await this.boss.send(this.schema, null, { singletonSeconds: 300 })

    assert.strictEqual(jobId2, null)
  })

  it('should throttle via sendThrottled()', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const seconds = 60

    const jobId1 = await this.boss.sendThrottled(this.schema, null, null, seconds)

    assert(jobId1)

    const jobId2 = await this.boss.sendThrottled(this.schema, null, null, seconds)

    assert.strictEqual(jobId2, null)
  })

  it('should not allow more than 1 complete job with the same key with an interval', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    const singletonKey = 'a'
    const singletonSeconds = 60

    await this.boss.send(this.schema, null, { singletonKey, singletonSeconds })
    const [job] = await this.boss.fetch(this.schema)

    await this.boss.complete(this.schema, job.id)

    const jobId = await this.boss.send(this.schema, null, { singletonKey, singletonSeconds })

    assert.strictEqual(jobId, null)
  })
})
