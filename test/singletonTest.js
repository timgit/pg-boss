const assert = require('assert')
const helper = require('./testHelper')

describe('singleton', function () {
  it('should not allow more than 1 pending job at a time with the same key', async function () {
    const queue = 'singleton-1-pending'
    const singletonKey = 'a'

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publish(queue, null, { singletonKey })

    assert(jobId)

    const jobId2 = await boss.publish(queue, null, { singletonKey })

    assert.strictEqual(jobId2, null)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should not allow more than 1 complete job with the same key with an interval', async function () {
    const queue = 'singleton-1-complete'
    const singletonKey = 'a'
    const singletonMinutes = 1

    const boss = await helper.start(this.test.bossConfig)
    await boss.publish(queue, null, { singletonKey, singletonMinutes })
    const job = await boss.fetch(queue)

    await boss.complete(job.id)

    const jobId = await boss.publish(queue, null, { singletonKey, singletonMinutes })

    assert.strictEqual(jobId, null)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should allow more than 1 pending job at the same time with different keys', async function () {
    const queue = 'singleton'

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publish(queue, null, { singletonKey: 'a' })

    assert(jobId)

    const jobId2 = await boss.publish(queue, null, { singletonKey: 'b' })

    assert(jobId2)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('publishOnce() should work', async function () {
    const queue = 'publishOnce'
    const key = 'only-once-plz'

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publishOnce(queue, null, null, key)

    assert(jobId)

    const jobId2 = await boss.publishOnce(queue, null, null, key)

    assert.strictEqual(jobId2, null)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('publishOnce() without a key should also work', async function () {
    const queue = 'publishOnceNoKey'

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publishOnce(queue)

    assert(jobId)

    const jobId2 = await boss.publishOnce(queue)

    assert.strictEqual(jobId2, null)

    await boss.stop(this.test.bossConfig.stopOptions)
  })
})
