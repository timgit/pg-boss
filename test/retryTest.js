const assert = require('assert')
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('retries', function () {
  const defaults = { maintenanceIntervalSeconds: 1 }

  it('should retry a job that didn\'t complete', async function () {
    const queue = 'unreliable'

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const jobId = await boss.publish({ name: queue, options: { expireInSeconds: 1, retryLimit: 1 } })

    const try1 = await boss.fetch(queue)

    await Promise.delay(5000)

    const try2 = await boss.fetch(queue)

    assert.strictEqual(try1.id, jobId)
    assert.strictEqual(try2.id, jobId)

    await boss.stop()
  })

  it('should retry a job that failed', async function () {
    const queueName = 'retryFailed'
    const retryLimit = 1

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const jobId = await boss.publish(queueName, null, { retryLimit })

    await boss.fetch(queueName)
    await boss.fail(jobId)

    const job = await boss.fetch(queueName)

    assert.strictEqual(job.id, jobId)

    await boss.stop()
  })

  it('should retry a job that failed with cascaded config', async function () {
    const queueName = 'retryFailed-config-cascade'
    const retryLimit = 1

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults, retryLimit })
    const jobId = await boss.publish(queueName)

    await boss.fetch(queueName)
    await boss.fail(jobId)

    const job = await boss.fetch(queueName)

    assert.strictEqual(job.id, jobId)

    await boss.stop()
  })

  it('should retry with a fixed delay', async function () {
    const queue = 'retryDelayFixed'

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const jobId = await boss.publish(queue, null, { retryLimit: 1, retryDelay: 1 })

    await boss.fetch(queue)
    await boss.fail(jobId)

    const job1 = await boss.fetch(queue)

    assert.strictEqual(job1, null)

    await Promise.delay(1000)

    const job2 = await boss.fetch(queue)

    assert(job2)

    await boss.stop()
  })

  it('should retry with a exponential backoff', async function () {
    const queue = 'retryDelayBackoff'

    let subscribeCount = 0
    const retryLimit = 4

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.subscribe(queue, { newJobCheckInterval: 500 }, job => job.done(++subscribeCount))
    await boss.publish(queue, null, { retryLimit, retryBackoff: true })

    await Promise.delay(9000)

    assert(subscribeCount < retryLimit)

    await boss.stop()
  })

  it('should set the default retry limit to 1 if missing', async function () {
    const queue = 'retryLimitDefault'

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const jobId = await boss.publish(queue, null, { retryDelay: 1 })
    await boss.fetch(queue)
    await boss.fail(jobId)

    const job1 = await boss.fetch(queue)

    assert.strictEqual(job1, null)

    await Promise.delay(1000)

    const job2 = await boss.fetch(queue)

    assert(job2)

    await boss.stop()
  })
})
