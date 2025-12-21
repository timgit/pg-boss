import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('failure', function () {
  it('should reject missing id argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.fail()
    })
  })

  it('should fail a job when requested', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)

    const [job] = await testContext.boss.fetch(testContext.schema)

    await testContext.boss.fail(testContext.schema, job.id)
  })

  it('should fail a batch of jobs', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await Promise.all([
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema)
    ])

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize: 3 })

    const result = await testContext.boss.fail(testContext.schema, jobs.map(job => job.id))

    assert.strictEqual(result.jobs.length, 3)
  })

  it('should fail a batch of jobs with a data arg', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const message = 'some error'

    await Promise.all([
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema)
    ])

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize: 3 })

    await testContext.boss.fail(testContext.schema, jobs.map(job => job.id), new Error(message))

    const results = await Promise.all(jobs.map(job => testContext.boss!.getJobById(testContext.schema, job.id)))

    // @ts-ignore
    assert(results.every(i => i!.output.message === message))
  })

  it('should preserve nested objects within a payload that is an instance of Error', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const failPayload = new Error('Something went wrong')
    // @ts-ignore
    failPayload.some = { deeply: { nested: { reason: 'nuna' } } }

    const jobId = await testContext.boss.send(testContext.schema)

    assert(jobId)

    await testContext.boss.fail(testContext.schema, jobId, failPayload)

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert(job?.output)

    // @ts-ignore
    assert.strictEqual(job.output.some.deeply.nested.reason, failPayload.some.deeply.nested.reason)
  })

  it('failure via Promise reject() should pass string wrapped in value prop', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })
    const failPayload = 'mah error'

    const spy = testContext.boss.getSpy(testContext.schema)
    const jobId = await testContext.boss.send(testContext.schema)

    assert(jobId)

    await testContext.boss.work(testContext.schema, () => Promise.reject(failPayload))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert.strictEqual((job!.output as { value: string }).value, failPayload)
  })

  it('failure via Promise reject() should pass object payload', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = testContext.boss.getSpy(testContext.schema)
    const errorResponse = new Error('custom error')
    // @ts-ignore
    errorResponse.something = something

    const jobId = await testContext.boss.send(testContext.schema)

    assert(jobId)

    await testContext.boss.work(testContext.schema, () => Promise.reject(errorResponse))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert.strictEqual((job!.output as { something: string }).something, something)
  })

  it('failure with Error object should be saved in the job', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })
    const message = 'a real error!'

    const spy = testContext.boss.getSpy(testContext.schema)
    const jobId = await testContext.boss.send(testContext.schema)

    assert(jobId)

    await testContext.boss.work(testContext.schema, async () => { throw new Error(message) })

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert((job!.output as { message: string }).message.includes(message))
  })

  it('should fail a job with custom connection', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)

    const [job] = await testContext.boss.fetch(testContext.schema)

    let called = false
    const _db = await helper.getDb()
    const db = {
      // @ts-ignore
      async executeSql (sql, values) {
        called = true
        // @ts-ignore
        return _db.pool.query(sql, values)
      }
    }

    await testContext.boss.fail(testContext.schema, job.id, null, { db })

    assert.strictEqual(called, true)
  })

  it('failure with circular payload should be safely serialized', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, __test__enableSpies: true })

    const spy = testContext.boss.getSpy(testContext.schema)
    const jobId = await testContext.boss.send(testContext.schema)

    assert(jobId)

    const message = 'mhmm'

    await testContext.boss.work(testContext.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      const err = { message }
      // @ts-ignore
      err.myself = err
      throw err
    })

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert.strictEqual((job!.output as { message: string }).message, message)
  })

  it('dead letter queues are working', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    const deadLetter = `${testContext.schema}_dlq`

    await testContext.boss.createQueue(deadLetter)
    await testContext.boss.createQueue(testContext.schema, { deadLetter })

    const jobId = await testContext.boss.send(testContext.schema, { key: testContext.schema }, { retryLimit: 0 })

    assert(jobId)

    await testContext.boss.fetch(testContext.schema)
    await testContext.boss.fail(testContext.schema, jobId)

    const [job] = await testContext.boss.fetch<{ key: string }>(deadLetter)

    assert.strictEqual(job.data.key, testContext.schema)
  })

  it('should fail active jobs in a worker during shutdown', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

    await testContext.boss.work(testContext.schema, async () => await delay(4000))

    await delay(500)

    await testContext.boss.stop({ timeout: 2000 })

    await testContext.boss.start()

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(job?.id, jobId)
  })
})
