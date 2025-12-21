import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'
import { it } from 'vitest'

describe('retries', function () {
  it('should retry a job that didn\'t complete', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send({ name: testContext.schema, options: { expireInSeconds: 1, retryLimit: 1 } })

    const [try1] = await testContext.boss.fetch(testContext.schema)

    await delay(1000)
    await testContext.boss.supervise()

    const [try2] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(try1.id, jobId)
    assert.strictEqual(try2.id, jobId)
  })

  it('should retry a job that failed', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

    await testContext.boss.fetch(testContext.schema)
    await testContext.boss.fail(testContext.schema, jobId!)

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(job.id, jobId)
  })

  it('should retry with a fixed delay', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema, null, { retryLimit: 1, retryDelay: 1 })

    await testContext.boss.fetch(testContext.schema)
    await testContext.boss.fail(testContext.schema, jobId!)

    const [job1] = await testContext.boss.fetch(testContext.schema)

    assert(!job1)

    await delay(1000)

    const [job2] = await testContext.boss.fetch(testContext.schema)

    assert(job2)
  })

  it('should retry with a exponential backoff', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    let processCount = 0
    const retryLimit = 4

    await testContext.boss.work(testContext.schema, { pollingIntervalSeconds: 1 }, async () => {
      ++processCount
      throw new Error('retry')
    })

    await testContext.boss.send(testContext.schema, null, { retryLimit, retryDelay: 2, retryBackoff: true })

    await delay(8000)

    assert(processCount < retryLimit)
  })

  it('should limit retry delay with exponential backoff', { timeout: 15000 }, async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const startAfters: Date[] = []
    const retryDelayMax = 3

    await testContext.boss.work(testContext.schema, { pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
      startAfters.push(job.startAfter)
      throw new Error('retry')
    })

    await testContext.boss.send(testContext.schema, null, {
      retryLimit: 4,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax
    })

    await delay(13000)

    const delays = startAfters.map((startAfter, index) =>
      index === 0 ? 0 : (startAfter.getTime() - startAfters[index - 1].getTime()) / 1000)

    for (const d of delays) {
      // the +1 eval here is to allow latency from the work() polling interval
      assert(d < (retryDelayMax + 1), `Expected delay to be less than ${retryDelayMax + 1} seconds, but got ${d}`)
    }
  })

  it('should mark a failed job to be retried', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const jobId = await testContext.boss.send(testContext.schema, null, { retryLimit: 0 })
    await testContext.boss.fail(testContext.schema, jobId!)
    await testContext.boss.retry(testContext.schema, jobId!)
    const job = await testContext.boss.getJobById(testContext.schema, jobId!)
    assert(job)
    const { state, retryLimit } = job
    assert(state === 'retry')
    assert(retryLimit === 1)
  })
})
