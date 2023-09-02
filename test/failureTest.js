const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')
const pMap = require('p-map')

describe('failure', function () {
  it('should reject missing id argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.fail()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail a job when requested', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const job = await boss.fetch(queue)

    await boss.fail(job.id)
  })

  it('should fail a batch of jobs', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    const result = await boss.fail(jobs.map(job => job.id))

    assert.strictEqual(result.jobs.length, 3)
  })

  it('should fail a batch of jobs with a data arg', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const message = 'some error'

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    await boss.fail(jobs.map(job => job.id), new Error(message))

    const results = await pMap(jobs, job => boss.getJobById(job.id))

    assert(results.every(i => i.output.message === message))
  })

  it('should preserve nested objects within a payload that is an instance of Error', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const failPayload = new Error('Something went wrong')
    failPayload.some = { deeply: { nested: { reason: 'nuna' } } }

    const jobId = await boss.send(queue)

    await boss.fail(jobId, failPayload)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.some.deeply.nested.reason, failPayload.some.deeply.nested.reason)
  })

  it('failure via Promise reject() should pass string wrapped in value prop', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const failPayload = 'mah error'

    const jobId = await boss.send(queue)
    await boss.work(queue, () => Promise.reject(failPayload))

    await delay(1000)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.value, failPayload)
  })

  it('failure via Promise reject() should pass object payload', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const something = 'clever'

    const errorResponse = new Error('custom error')
    errorResponse.something = something

    const jobId = await boss.send(queue)
    await boss.work(queue, () => Promise.reject(errorResponse))

    await delay(1000)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.something, something)
  })

  it('failure with Error object should be saved in the job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const message = 'a real error!'

    const jobId = await boss.send(queue)
    await boss.work(queue, async () => { throw new Error(message) })

    await delay(1000)

    const job = await boss.getJobById(jobId)

    assert(job.output.message.includes(message))
  })

  it('should fail a job with custom connection', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const job = await boss.fetch(queue)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        called = true
        return _db.pool.query(sql, values)
      }
    }

    await boss.fail(job.id, null, { db })

    assert.strictEqual(called, true)
  })

  it('failure with circular payload should be safely serialized', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)
    const message = 'mhmm'

    await boss.work(queue, { newJobCheckInterval: 500 }, async () => {
      const err = { message }
      err.myself = err
      throw err
    })

    await delay(2000)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.message, message)
  })

  it('dead letter queues are working', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema
    const deadLetter = `${queue}_dlq`

    const jobId = await boss.send(queue, { key: queue }, { deadLetter })

    await boss.fetch(queue)
    await boss.fail(jobId)

    const job = await boss.fetch(deadLetter)

    assert.strictEqual(job.data.key, queue)
  })

  it('should fail active jobs in a worker during shutdown', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1, expireInSeconds: 60 })

    await boss.work(queue, async () => await delay(10000))

    await delay(1000)

    await boss.stop({ wait: true, timeout: 2000 })

    await boss.start()

    const job = await boss.fetch(queue)

    assert.strictEqual(job?.id, jobId)
  })
})
