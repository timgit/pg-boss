const assert = require('assert')
const helper = require('./testHelper')
const { delay } = require('../src/tools')

describe('retries', function () {
  it('should retry a job that didn\'t complete', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send({ name: queue, options: { expireInSeconds: 1, retryLimit: 1 } })

    const try1 = await boss.fetch(queue)

    await delay(1000)
    await boss.maintain()

    const try2 = await boss.fetch(queue)

    assert.strictEqual(try1.id, jobId)
    assert.strictEqual(try2.id, jobId)
  })

  it('should retry a job that failed', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1 })

    await boss.fetch(queue)
    await boss.fail(queue, jobId)

    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry a job that failed with cascaded config', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, retryLimit: 1 })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    await boss.fetch(queue)
    await boss.fail(queue, jobId)

    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry with a fixed delay', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 1 })

    await boss.fetch(queue)
    await boss.fail(queue, jobId)

    const job1 = await boss.fetch(queue)

    assert.strictEqual(job1, null)

    await delay(1000)

    const job2 = await boss.fetch(queue)

    assert(job2)
  })

  it('should retry with a exponential backoff', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    let processCount = 0
    const retryLimit = 5

    await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async () => {
      ++processCount
      throw new Error('retry')
    })

    await boss.send(queue, null, { retryLimit, retryBackoff: true })

    await delay(9000)

    assert(processCount < retryLimit)
  })
})
