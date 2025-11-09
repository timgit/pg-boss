import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('retries', function () {
  it('should retry a job that didn\'t complete', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send({ name: this.schema, options: { expireInSeconds: 1, retryLimit: 1 } })

    const [try1] = await this.boss.fetch(this.schema)

    await delay(1000)
    await this.boss.supervise()

    const [try2] = await this.boss.fetch(this.schema)

    assert.strictEqual(try1.id, jobId)
    assert.strictEqual(try2.id, jobId)
  })

  it('should retry a job that failed', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema, null, { retryLimit: 1 })

    await this.boss.fetch(this.schema)
    await this.boss.fail(this.schema, jobId!)

    const [job] = await this.boss.fetch(this.schema)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry with a fixed delay', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema, null, { retryLimit: 1, retryDelay: 1 })

    await this.boss.fetch(this.schema)
    await this.boss.fail(this.schema, jobId!)

    const [job1] = await this.boss.fetch(this.schema)

    assert(!job1)

    await delay(1000)

    const [job2] = await this.boss.fetch(this.schema)

    assert(job2)
  })

  it('should retry with a exponential backoff', async function () {
    this.boss = await helper.start(this.bossConfig)

    let processCount = 0
    const retryLimit = 4

    await this.boss.work(this.schema, { pollingIntervalSeconds: 1 }, async () => {
      ++processCount
      throw new Error('retry')
    })

    await this.boss.send(this.schema, null, { retryLimit, retryDelay: 2, retryBackoff: true })

    await delay(8000)

    assert(processCount < retryLimit)
  })

  it('should limit retry delay with exponential backoff', async function () {
    this.boss = await helper.start(this.bossConfig)

    const startAfters = []
    const retryDelayMax = 3

    await this.boss.work(this.schema, { pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
      startAfters.push(job.startAfter)
      throw new Error('retry')
    })

    await this.boss.send(this.schema, null, {
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
    this.boss = await helper.start(this.bossConfig)
    const jobId = await this.boss.send(this.schema, null, { retryLimit: 0 })
    await this.boss.fail(this.schema, jobId!)
    await this.boss.retry(this.schema, jobId!)
    const { state, retryLimit } = await this.boss.getJobById(this.schema, jobId!)
    assert(state === 'retry')
    assert(retryLimit === 1)
  })
})
