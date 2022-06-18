const assert = require('assert')
const { v4: uuid } = require('uuid')
const helper = require('./testHelper')

describe('singleton', function () {
  it('should not allow more than 1 pending job at a time with the same key', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'singleton-1-pending'
    const singletonKey = 'a'

    const jobId = await boss.send(queue, null, { singletonKey })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonKey })

    assert.strictEqual(jobId2, null)
  })

  it('should not allow more than 1 complete job with the same key with an interval', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'singleton-1-complete'
    const singletonKey = 'a'
    const singletonMinutes = 1

    await boss.send(queue, null, { singletonKey, singletonMinutes })
    const job = await boss.fetch(queue)

    await boss.complete(job.id)

    const jobId = await boss.send(queue, null, { singletonKey, singletonMinutes })

    assert.strictEqual(jobId, null)
  })

  it('should allow more than 1 pending job at the same time with different keys', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'singleton'
    const jobId = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonKey: 'b' })

    assert(jobId2)
  })

  it('sendOnce() should work', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'sendOnce'
    const key = 'only-once-plz'

    const jobId = await boss.sendOnce(queue, null, null, key)

    assert(jobId)

    const jobId2 = await boss.sendOnce(queue, null, null, key)

    assert.strictEqual(jobId2, null)

    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    const jobId3 = await boss.sendOnce(queue, null, null, key)

    assert.strictEqual(jobId3, null)
  })

  it('sendOnce() without a key should also work', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'sendOnceNoKey'
    const jobId = await boss.sendOnce(queue)

    assert(jobId)

    const jobId2 = await boss.sendOnce(queue)

    assert.strictEqual(jobId2, null)
  })

  it('sendSingleton() works', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = this.test.bossConfig.schema

    const jobId = await boss.sendSingleton(queue)

    assert(jobId)

    const jobId2 = await boss.sendSingleton(queue)

    assert.strictEqual(jobId2, null)

    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    const jobId3 = await boss.sendSingleton(queue)

    assert(jobId3)
  })

  it('useSingletonQueue allows a second singleton job if first has enetered active state', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'singleton-queue-check'
    const singletonKey = 'myKey'

    const jobId = await boss.send(queue, null, { singletonKey, useSingletonQueue: true })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonKey, useSingletonQueue: true })

    assert.strictEqual(jobId2, null)

    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    const jobId3 = await boss.send(queue, null, { singletonKey, useSingletonQueue: true })

    assert(jobId3)
  })

  it('useSingletonQueue works when using insert', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const name = 'singleton-queue-check'
    const singletonKey = 'myKey'

    const jobId = uuid()
    await boss.insert([{ id: jobId, name, singletonKey, useSingletonQueue: true }])

    assert(await boss.getJobById(jobId))

    const jobId2 = uuid()
    await boss.insert([{ id: jobId2, name, singletonKey, useSingletonQueue: true }])

    assert.strictEqual(await boss.getJobById(jobId2), null)

    const job = await boss.fetch(name)

    assert.strictEqual(job.id, jobId)

    const jobId3 = uuid()
    await boss.insert([{ id: jobId3, name, singletonKey, useSingletonQueue: true }])

    assert(await boss.getJobById(jobId3))
  })
})
