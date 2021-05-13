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

    const queue = 'will-fail'

    await boss.publish(queue)

    const job = await boss.fetch(queue)

    await boss.fail(job.id)
  })

  it('should subscribe to a job failure', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'subscribe-fail'
    const jobId = await boss.publish(queue, null, { onComplete: true })

    const job = await boss.fetch(queue)

    await boss.fail(job.id)

    return new Promise((resolve, reject) => {
      boss.onComplete(queue, async job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual('failed', job.data.state)
        resolve()
      }).catch(reject)
    })
  })

  it('should fail a batch of jobs', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'complete-batch'

    await Promise.all([
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    await boss.fail(jobs.map(job => job.id))
  })

  it('should fail a batch of jobs with a data arg', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const message = 'some error'

    await Promise.all([
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    await boss.fail(jobs.map(job => job.id), new Error(message))

    const results = await pMap(jobs, job => boss.getJobById(job.id))

    assert(results.every(i => i.output.message === message))
  })

  it('should accept a payload', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'fail-payload'
    const failPayload = { someReason: 'nuna' }

    const jobId = await boss.publish(queue, null, { onComplete: true })

    await boss.fail(jobId, failPayload)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.someReason, failPayload.someReason)
  })

  it('subscribe failure via done() should pass error payload to failed job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'fetchFailureWithPayload'
    const errorMessage = 'mah error'

    await boss.publish(queue, null, { onComplete: true })

    return new Promise((resolve) => {
      boss.subscribe(queue, async job => {
        const error = new Error(errorMessage)

        await job.done(error)

        const failedJob = await boss.fetchCompleted(queue)

        assert.strictEqual(failedJob.data.state, 'failed')
        assert.strictEqual(failedJob.data.response.message, errorMessage)

        resolve()
      })
    })
  })

  it('subscribe failure via Promise reject() should pass string wrapped in value prop', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'subscribeFailureViaRejectString'
    const failPayload = 'mah error'

    await boss.subscribe(queue, job => Promise.reject(failPayload))
    await boss.publish(queue, null, { onComplete: true })

    await delay(7000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.value, failPayload)
  })

  it('subscribe failure via Promise reject() should pass object payload', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'subscribeFailureViaRejectObject'
    const something = 'clever'

    const errorResponse = new Error('custom error')
    errorResponse.something = something

    await boss.subscribe(queue, job => Promise.reject(errorResponse))
    await boss.publish(queue, null, { onComplete: true })

    await delay(7000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.something, something)
  })

  it('failure with Error object should get stored in the failure job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'failWithErrorObj'
    const message = 'a real error!'

    await boss.publish(queue, null, { onComplete: true })
    await boss.subscribe(queue, async () => { throw new Error(message) })

    await delay(2000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert(job.data.response.message.includes(message))
  })
})
