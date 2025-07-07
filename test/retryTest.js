const assert = require('node:assert')
const helper = require('./testHelper')
const { delay } = require('../src/tools')

describe('retries', function () {
  it('should retry a job that didn\'t complete', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send({ name: queue, options: { expireInSeconds: 1, retryLimit: 1 } })

    const [try1] = await boss.fetch(queue)

    await delay(1000)
    await boss.maintain()

    const [try2] = await boss.fetch(queue)

    assert.strictEqual(try1.id, jobId)
    assert.strictEqual(try2.id, jobId)
  })

  it('should retry a job that failed', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1 })

    await boss.fetch(queue)
    await boss.fail(queue, jobId)

    const [job] = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry a job that failed with cascaded config', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, retryLimit: 1 })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    await boss.fetch(queue)
    await boss.fail(queue, jobId)

    const [job] = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry with a fixed delay', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 1 })

    await boss.fetch(queue)
    await boss.fail(queue, jobId)

    const [job1] = await boss.fetch(queue)

    assert(!job1)

    await delay(1000)

    const [job2] = await boss.fetch(queue)

    assert(job2)
  })

  it('should retry with a exponential backoff', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    let processCount = 0
    const retryLimit = 4

    await boss.work(queue, { pollingIntervalSeconds: 1 }, async () => {
      ++processCount
      throw new Error('retry')
    })

    await boss.send(queue, null, { retryLimit, retryDelay: 2, retryBackoff: true })

    await delay(8000)

    assert(processCount < retryLimit)
  })

  it('should limit retry delay with exponential backoff', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const startAfters = []
    const retryDelayMax = 3

    await boss.work(queue, { pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
      startAfters.push(job.startAfter)
      throw new Error('retry')
    })

    await boss.send(queue, null, {
      retryLimit: 4,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax
    })

    await delay(13000)

    const delays = startAfters.map((startAfter, index) =>
      index === 0 ? 0 : (startAfter - startAfters[index - 1]) / 1000)

    for (const d of delays) {
      // the +1 eval here is to allow latency from the work() polling interval
      assert(d < (retryDelayMax + 1), `Expected delay to be less than ${retryDelayMax + 1} seconds, but got ${d}`)
    }
  }).timeout(15000)

  it('should mark a failed job to be retried', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema
    const jobId = await boss.send(queue, null, { retryLimit: 0 })
    await boss.fail(queue, jobId)
    await boss.retry(queue, jobId)
    const { state, retryLimit } = await boss.getJobById(queue, jobId)
    assert(state === 'retry')
    assert(retryLimit === 1)
  })
})
