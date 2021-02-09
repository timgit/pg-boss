const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')

describe('failure', function () {
  it('should reject missing id argument', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.fail()
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should fail a job when requested', async function () {
    const boss = await helper.start(this.test.bossConfig)
    const queue = 'will-fail'

    await boss.publish(queue)

    const job = await boss.fetch(queue)

    await boss.fail(job.id)

    await boss.stop()
  })

  it('should subscribe to a job failure', async function () {
    const queue = 'subscribe-fail'

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publish(queue)

    const job = await boss.fetch(queue)

    await boss.fail(job.id)

    return new Promise((resolve, reject) => {
      boss.onComplete(queue, async job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual('failed', job.data.state)

        await boss.stop()
        resolve()
      }).catch(reject)
    })
  })

  it('should fail a batch of jobs', async function () {
    const queue = 'complete-batch'

    const boss = await helper.start(this.test.bossConfig)

    await Promise.all([
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    await boss.fail(jobs.map(job => job.id))
    await boss.stop()
  })

  it('should accept a payload', async function () {
    const queue = 'fail-payload'
    const failPayload = { someReason: 'nuna' }

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publish(queue)

    await boss.fail(jobId, failPayload)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.someReason, failPayload.someReason)

    await boss.stop()
  })

  it('subscribe failure via done() should pass error payload to failed job', function (finished) {
    const queue = 'fetchFailureWithPayload'
    const errorMessage = 'mah error'

    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)
      await boss.publish(queue)

      boss.subscribe(queue, job => {
        const error = new Error(errorMessage)

        handler().catch(err => finished(err))

        async function handler () {
          await job.done(error)

          const failedJob = await boss.fetchCompleted(queue)

          assert.strictEqual(failedJob.data.state, 'failed')
          assert.strictEqual(failedJob.data.response.message, errorMessage)

          await boss.stop()

          finished()
        }
      })
    }
  })

  it('subscribe failure via Promise reject() should pass string wrapped in value prop', async function () {
    const queue = 'subscribeFailureViaRejectString'
    const failPayload = 'mah error'

    const boss = await helper.start(this.test.bossConfig)
    await boss.subscribe(queue, job => Promise.reject(failPayload))
    await boss.publish(queue)

    await delay(7000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.value, failPayload)

    await boss.stop()
  })

  it('subscribe failure via Promise reject() should pass object payload', async function () {
    const queue = 'subscribeFailureViaRejectObject'
    const something = 'clever'

    const errorResponse = new Error('custom error')
    errorResponse.something = something

    const boss = await helper.start(this.test.bossConfig)
    await boss.subscribe(queue, job => Promise.reject(errorResponse))
    await boss.publish(queue)

    await delay(7000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.something, something)

    await boss.stop()
  })

  it('failure with Error object should get stored in the failure job', async function () {
    const queue = 'failWithErrorObj'
    const message = 'a real error!'

    const boss = await helper.start(this.test.bossConfig)
    await boss.publish(queue)
    await boss.subscribe(queue, async () => { throw new Error(message) })

    await delay(2000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert(job.data.response.message.includes(message))

    await boss.stop()
  })
})
