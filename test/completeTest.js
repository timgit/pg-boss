const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')
const PgBoss = require('../')

describe('complete', function () {
  it('should reject missing id argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.complete()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should complete a batch of jobs', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'complete-batch'
    const batchSize = 3

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const countJobs = (state) => helper.countJobs(this.test.bossConfig.schema, 'name = $1 AND state = $2', [queue, state])

    const jobs = await boss.fetch(queue, batchSize)

    const activeCount = await countJobs(PgBoss.states.active)

    assert.strictEqual(activeCount, batchSize)

    await boss.complete(jobs.map(job => job.id))

    const completed = await boss.fetchCompleted(queue, batchSize)

    assert.strictEqual(batchSize, completed.length)
  })

  it('onComplete should have the payload from complete() in the response object', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const jobName = 'part-of-something-important'
    const responsePayload = { message: 'super-important-payload', arg2: '123' }

    await boss.send(jobName)

    const job = await boss.fetch(jobName)

    await boss.complete(job.id, responsePayload)

    return new Promise((resolve) => {
      boss.onComplete(jobName, async job => {
        assert.strictEqual(job.data.response.message, responsePayload.message)
        assert.strictEqual(job.data.response.arg2, responsePayload.arg2)

        resolve()
      })
    })
  })

  it('onComplete should have the original payload in request object', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queueName = 'onCompleteRequestTest'
    const requestPayload = { foo: 'bar' }

    const jobId = await boss.send(queueName, requestPayload)

    const job = await boss.fetch(queueName)
    await boss.complete(job.id)

    return new Promise((resolve) => {
      boss.onComplete(queueName, async job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual(job.data.request.data.foo, requestPayload.foo)

        resolve()
      })
    })
  })

  it('onComplete should have both request and response', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const jobName = 'onCompleteFtw'
    const requestPayload = { token: 'trivial' }
    const responsePayload = { message: 'so verbose', code: '1234' }

    const jobId = await boss.send(jobName, requestPayload)
    const job = await boss.fetch(jobName)

    await boss.complete(job.id, responsePayload)

    return new Promise((resolve) => {
      boss.onComplete(jobName, async job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual(job.data.request.data.token, requestPayload.token)
        assert.strictEqual(job.data.response.message, responsePayload.message)
        assert.strictEqual(job.data.response.code, responsePayload.code)

        resolve()
      })
    })
  })

  it('should remove an onComplete worker', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const jobName = 'offComplete'

    let receivedCount = 0

    boss.onComplete(jobName, { newJobCheckInterval: 500 }, async job => {
      receivedCount++
      await boss.offComplete(jobName)
    })

    await boss.send(jobName)
    const job1 = await boss.fetch(jobName)
    await boss.complete(job1.id)

    await delay(2000)

    await boss.send(jobName)
    const job2 = await boss.fetch(jobName)
    await boss.complete(job2.id)

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should remove an onComplete worker by id', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })
    const queue = this.test.bossConfig.schema

    let receivedCount = 0

    await boss.send(queue)
    const job1 = await boss.fetch(queue)
    await boss.complete(job1.id)

    await boss.send(queue)
    const job2 = await boss.fetch(queue)
    await boss.complete(job2.id)

    const id = await boss.onComplete(queue, { newJobCheckInterval: 500 }, async () => {
      receivedCount++
      await boss.offComplete({ id })
    })

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should fetch a completed job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'fetchCompleted'
    const jobId = await boss.send(queue)
    await boss.fetch(queue)
    await boss.complete(jobId)
    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.request.id, jobId)
  })

  it('should not create an extra state job after completion', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'noMoreExtraStateJobs'
    const config = this.test.bossConfig

    const jobId = await boss.send(queue)

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    await boss.complete(job.id)

    const stateJobCount = await helper.countJobs(config.schema, 'name = $1', [`${helper.COMPLETION_JOB_PREFIX}${queue}`])

    assert.strictEqual(stateJobCount, 1)
  })

  it('should not create a completion job if opted out during send', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'onCompleteOptOut'

    const jobId = await boss.send(queue, null, { onComplete: false })

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job, null)
  })

  it('should not create a completion job if opted out during constructor', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: false })

    const queue = 'onCompleteOptOutGlobal'

    const jobId = await boss.send(queue)

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job, null)
  })

  it('should create completion job if overriding the default from constructor', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: false })

    const queue = 'onCompleteOptInOverride'

    const jobId = await boss.send(queue, null, { onComplete: true })

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.request.id, jobId)
  })

  it('should store job output in job.output from complete()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'completion-data-in-job-output'

    const jobId = await boss.send(queue, null, { onComplete: false })

    const { id } = await boss.fetch(queue)

    assert.strictEqual(jobId, id)

    const completionData = { msg: 'i am complete' }

    await boss.complete(jobId, completionData)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.msg, completionData.msg)
  })

  it('should store job error in job.output from fail()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'completion-data-in-job-output'

    const jobId = await boss.send(queue, null, { onComplete: false })

    const { id } = await boss.fetch(queue)

    assert.strictEqual(jobId, id)

    const completionError = new Error('i am complete')

    await boss.fail(jobId, completionError)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.message, completionError.message)
  })

  it('should complete a batch of jobs with custom connection', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'complete-batch'
    const batchSize = 3

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const countJobs = (state) => helper.countJobs(this.test.bossConfig.schema, 'name = $1 AND state = $2', [queue, state])

    const jobs = await boss.fetch(queue, batchSize)

    const activeCount = await countJobs(PgBoss.states.active)

    assert.strictEqual(activeCount, batchSize)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        called = true
        return _db.pool.query(sql, values)
      }
    }

    await boss.complete(jobs.map(job => job.id), null, { db })

    const completed = await boss.fetchCompleted(queue, batchSize)

    assert.strictEqual(batchSize, completed.length)
    assert.strictEqual(called, true)
  })
})
