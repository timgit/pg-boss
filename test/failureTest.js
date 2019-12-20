const Promise = require('bluebird')
const assert = require('chai').assert
const helper = require('./testHelper')

describe('failure', function () {
  this.timeout(10000)

  let boss

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('should reject missing id argument', function (finished) {
    boss.fail().catch(() => finished())
  })

  it('should fail a job when requested', async function () {
    this.timeout(3000)

    const queue = 'will-fail'

    await boss.publish(queue)

    const job = await boss.fetch(queue)

    await boss.fail(job.id)
  })

  it('should subscribe to a job failure', function (finished) {
    this.timeout(3000)

    test()

    async function test () {
      const queue = 'subscribe-fail'

      const jobId = await boss.publish(queue)

      const job = await boss.fetch(queue)

      await boss.fail(job.id)

      boss.onComplete(queue, job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual('failed', job.data.state)

        finished()
      })
    }
  })

  it('should fail a batch of jobs', async function () {
    const queue = 'complete-batch'

    await Promise.all([
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    await boss.fail(jobs.map(job => job.id))
  })

  it('should accept a payload', async function () {
    const queue = 'fail-payload'
    const failPayload = { someReason: 'nuna' }

    const jobId = await boss.publish(queue)

    await boss.fail(jobId, failPayload)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.someReason, failPayload.someReason)
  })

  it('subscribe failure via done() should pass error payload to failed job', function (finished) {
    const queue = 'fetchFailureWithPayload'
    const errorMessage = 'mah error'

    test()

    async function test () {
      await boss.publish(queue)

      boss.subscribe(queue, job => {
        const error = new Error(errorMessage)

        handler().catch(err => finished(err))

        async function handler () {
          await job.done(error)

          const failedJob = await boss.fetchCompleted(queue)

          assert.strictEqual(failedJob.data.state, 'failed')
          assert.strictEqual(failedJob.data.response.message, errorMessage)

          finished()
        }
      })
    }
  })

  it('subscribe failure via Promise reject() should pass string wrapped in value prop', async function () {
    const queue = 'subscribeFailureViaRejectString'
    const failPayload = 'mah error'

    await boss.subscribe(queue, job => Promise.reject(failPayload))
    await boss.publish(queue)

    await Promise.delay(2000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.value, failPayload)
  })

  it('subscribe failure via Promise reject() should pass object payload', async function () {
    const queue = 'subscribeFailureViaRejectObject'
    const something = 'clever'

    const errorResponse = new Error('custom error')
    errorResponse.something = something

    await boss.subscribe(queue, job => Promise.reject(errorResponse))
    await boss.publish(queue)

    await Promise.delay(2000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.something, something)
  })

  it('failure with Error object should get stored in the failure job', async function () {
    const queue = 'failWithErrorObj'
    const message = 'a real error!'

    await boss.publish(queue)
    await boss.subscribe(queue, async () => { throw new Error(message) })

    await Promise.delay(2000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.message.indexOf(message), 0)
  })
})
