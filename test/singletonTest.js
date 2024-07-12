const assert = require('assert')
const helper = require('./testHelper')

describe('singleton keys', function () {
  it('should not allow more than 1 pending job at a time with the same key', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const singletonKey = 'a'

    const jobId = await boss.send(queue, null, { singletonKey })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonKey })

    assert.strictEqual(jobId2, null)
  })

  it('should not allow more than 1 complete job with the same key with an interval', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const singletonKey = 'a'
    const singletonMinutes = 1

    await boss.send(queue, null, { singletonKey, singletonMinutes })
    const job = await boss.fetch(queue)

    await boss.complete(queue, job.id)

    const jobId = await boss.send(queue, null, { singletonKey, singletonMinutes })

    assert.strictEqual(jobId, null)
  })

  it('should allow more than 1 pending job at the same time with different keys', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonKey: 'b' })

    assert(jobId2)
  })
})
