import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import * as helper from './testHelper.ts'

describe('failure', function () {
  it('should reject missing id argument', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await this.boss.fail()
    })
  })

  it('should fail a job when requested', async function () {
    this.boss = await helper.start(this.bossConfig)

    await this.boss.send(this.schema)

    const [job] = await this.boss.fetch(this.schema)

    await this.boss.fail(this.schema, job.id)
  })

  it('should fail a batch of jobs', async function () {
    this.boss = await helper.start(this.bossConfig)

    await Promise.all([
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema)
    ])

    const jobs = await this.boss.fetch(this.schema, { batchSize: 3 })

    const result = await this.boss.fail(this.schema, jobs.map(job => job.id))

    assert.strictEqual(result.jobs.length, 3)
  })

  it('should fail a batch of jobs with a data arg', async function () {
    this.boss = await helper.start(this.bossConfig)
    const message = 'some error'

    await Promise.all([
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema)
    ])

    const jobs = await this.boss.fetch(this.schema, { batchSize: 3 })

    await this.boss.fail(this.schema, jobs.map(job => job.id), new Error(message))

    const results = await Promise.all(jobs.map(job => this.boss!.getJobById(this.schema, job.id)))

    // @ts-ignore
    assert(results.every(i => i!.output.message === message))
  })

  it('should preserve nested objects within a payload that is an instance of Error', async function () {
    this.boss = await helper.start(this.bossConfig)

    const failPayload = new Error('Something went wrong')
    // @ts-ignore
    failPayload.some = { deeply: { nested: { reason: 'nuna' } } }

    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    await this.boss.fail(this.schema, jobId, failPayload)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert(job?.output)

    // @ts-ignore
    assert.strictEqual(job.output.some.deeply.nested.reason, failPayload.some.deeply.nested.reason)
  })

  it('failure via Promise reject() should pass string wrapped in value prop', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })
    const failPayload = 'mah error'

    const spy = this.boss.getSpy(this.schema)
    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    await this.boss.work(this.schema, () => Promise.reject(failPayload))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await this.boss.getJobById(this.schema, jobId)

    assert.strictEqual((job!.output as { value: string }).value, failPayload)
  })

  it('failure via Promise reject() should pass object payload', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = this.boss.getSpy(this.schema)
    const errorResponse = new Error('custom error')
    // @ts-ignore
    errorResponse.something = something

    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    await this.boss.work(this.schema, () => Promise.reject(errorResponse))

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await this.boss.getJobById(this.schema, jobId)

    assert.strictEqual((job!.output as { something: string }).something, something)
  })

  it('failure with Error object should be saved in the job', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })
    const message = 'a real error!'

    const spy = this.boss.getSpy(this.schema)
    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    await this.boss.work(this.schema, async () => { throw new Error(message) })

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await this.boss.getJobById(this.schema, jobId)

    assert((job!.output as { message: string }).message.includes(message))
  })

  it('should fail a job with custom connection', async function () {
    this.boss = await helper.start(this.bossConfig)

    await this.boss.send(this.schema)

    const [job] = await this.boss.fetch(this.schema)

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

    await this.boss.fail(this.schema, job.id, null, { db })

    assert.strictEqual(called, true)
  })

  it('failure with circular payload should be safely serialized', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__enableSpies: true })

    const spy = this.boss.getSpy(this.schema)
    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    const message = 'mhmm'

    await this.boss.work(this.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      const err = { message }
      // @ts-ignore
      err.myself = err
      throw err
    })

    await spy.waitForJobWithId(jobId, 'failed')

    const job = await this.boss.getJobById(this.schema, jobId)

    assert.strictEqual((job!.output as { message: string }).message, message)
  })

  it('dead letter queues are working', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    const deadLetter = `${this.schema}_dlq`

    await this.boss.createQueue(deadLetter)
    await this.boss.createQueue(this.schema, { deadLetter })

    const jobId = await this.boss.send(this.schema, { key: this.schema }, { retryLimit: 0 })

    assert(jobId)

    await this.boss.fetch(this.schema)
    await this.boss.fail(this.schema, jobId)

    const [job] = await this.boss.fetch<{ key: string }>(deadLetter)

    assert.strictEqual(job.data.key, this.schema)
  })

  it('should fail active jobs in a worker during shutdown', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema, null, { retryLimit: 1 })

    await this.boss.work(this.schema, async () => await delay(4000))

    await delay(500)

    await this.boss.stop({ timeout: 2000 })

    await this.boss.start()

    const [job] = await this.boss.fetch(this.schema)

    assert.strictEqual(job?.id, jobId)
  })
})
