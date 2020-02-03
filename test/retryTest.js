const assert = require('chai').assert
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('retries', function () {
  this.timeout(10000)

  let boss
  const config = { maintenanceIntervalSeconds: 1, newJobCheckInterval: 200 }

  before(async function () { boss = await helper.start(config) })
  after(async function () { await boss.stop() })

  it('should retry a job that didn\'t complete', async function () {
    const queue = 'unreliable'
    const expireIn = '100 milliseconds'
    const retryLimit = 1

    const jobId = await boss.publish({ name: queue, options: { expireIn, retryLimit } })

    const try1 = await boss.fetch(queue)

    await Promise.delay(3000)

    const try2 = await boss.fetch(queue)

    assert.equal(try1.id, jobId)
    assert.equal(try2.id, jobId)
  })

  it('should retry a job that failed', async function () {
    const queueName = 'retryFailed'
    const retryLimit = 1

    const jobId = await boss.publish(queueName, null, { retryLimit })

    await boss.fetch(queueName)
    await boss.fail(jobId)

    const job = await boss.fetch(queueName)

    assert.equal(job.id, jobId)
  })

  it('should retry with a fixed delay', async function () {
    const queue = 'retryDelayFixed'

    const jobId = await boss.publish(queue, null, { retryLimit: 1, retryDelay: 1 })

    await boss.fetch(queue)
    await boss.fail(jobId)

    const job1 = await boss.fetch(queue)

    assert.strictEqual(job1, null)

    await Promise.delay(1000)

    const job2 = await boss.fetch(queue)

    assert.isOk(job2)
  })

  it('should retry with a exponential backoff', async function () {
    const queue = 'retryDelayBackoff'

    let subscribeCount = 0
    const retryLimit = 4

    await boss.subscribe(queue, { newJobCheckInterval: 500 }, job => job.done(++subscribeCount))
    await boss.publish(queue, null, { retryLimit, retryBackoff: true })

    await Promise.delay(9000)

    assert.isBelow(subscribeCount, retryLimit)
  })

  it('should set the default retry limit to 1 if missing', async function () {
    const queue = 'retryLimitDefault'

    const jobId = await boss.publish(queue, null, { retryDelay: 1 })
    await boss.fetch(queue)
    await boss.fail(jobId)

    const job1 = await boss.fetch(queue)

    assert.strictEqual(job1, null)

    await Promise.delay(1000)

    const job2 = await boss.fetch(queue)

    assert.isOk(job2)
  })
})
