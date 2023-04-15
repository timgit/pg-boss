const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('retries', function () {
  const defaults = { maintenanceIntervalSeconds: 1 }

  it('should retry a job that didn\'t complete', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'unreliable'

    const jobId = await boss.send({ name: queue, options: { expireInSeconds: 1, retryLimit: 1 } })

    const try1 = await boss.fetch(queue)

    await delay(5000)

    const try2 = await boss.fetch(queue)

    assert.strictEqual(try1.id, jobId)
    assert.strictEqual(try2.id, jobId)
  })

  it('should retry a job that failed', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queueName = 'retryFailed'
    const retryLimit = 1

    const jobId = await boss.send(queueName, null, { retryLimit })

    await boss.fetch(queueName)
    await boss.fail(jobId)

    const job = await boss.fetch(queueName)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry a job that failed with cascaded config', async function () {
    const retryLimit = 1
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults, retryLimit })

    const queueName = 'retryFailed-config-cascade'

    const jobId = await boss.send(queueName)

    await boss.fetch(queueName)
    await boss.fail(jobId)

    const job = await boss.fetch(queueName)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry with a fixed delay', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'retryDelayFixed'

    const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 1 })

    await boss.fetch(queue)
    await boss.fail(jobId)

    const job1 = await boss.fetch(queue)

    assert.strictEqual(job1, null)

    await delay(1000)

    const job2 = await boss.fetch(queue)

    assert(job2)
  })

  it('should retry with a exponential backoff', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'retryDelayBackoff'

    let processCount = 0
    const retryLimit = 4

    await boss.work(queue, { newJobCheckInterval: 500 }, async () => {
      ++processCount
      throw new Error('retry')
    })

    await boss.send(queue, null, { retryLimit, retryBackoff: true })

    await delay(9000)

    assert(processCount < retryLimit)
  })

  it('should set the default retry limit to 1 if missing', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'retryLimitDefault'

    const jobId = await boss.send(queue, null, { retryDelay: 1 })

    await boss.fetch(queue)
    await boss.fail(jobId)

    const job1 = await boss.fetch(queue)

    assert.strictEqual(job1, null)

    await delay(1000)

    const job2 = await boss.fetch(queue)

    assert(job2)
  })
})
