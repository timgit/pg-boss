const Promise = require('bluebird')
const assert = require('assert')
const helper = require('./testHelper')

describe('complete', function () {
  it('should reject missing id argument', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.complete()
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should complete a batch of jobs', async function () {
    const jobName = 'complete-batch'

    const boss = await helper.start(this.test.bossConfig)

    await Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])

    const jobs = await boss.fetch(jobName, 3)

    await boss.complete(jobs.map(job => job.id))

    await boss.stop()
  })

  it('onComplete should have the payload from complete() in the response object', function (finished) {
    const config = this.test.bossConfig

    test()

    async function test () {
      const jobName = 'part-of-something-important'
      const responsePayload = { message: 'super-important-payload', arg2: '123' }

      const boss = await helper.start(config)

      await boss.publish(jobName)

      const job = await boss.fetch(jobName)

      await boss.complete(job.id, responsePayload)

      boss.onComplete(jobName, async job => {
        assert.strictEqual(job.data.response.message, responsePayload.message)
        assert.strictEqual(job.data.response.arg2, responsePayload.arg2)

        await boss.stop()

        finished()
      })
    }
  })

  it('onComplete should have the original payload in request object', function (finished) {
    const config = this.test.bossConfig

    test()

    async function test () {
      const queueName = 'onCompleteRequestTest'
      const requestPayload = { foo: 'bar' }

      const boss = await helper.start(config)
      const jobId = await boss.publish(queueName, requestPayload)

      boss.onComplete(queueName, async job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual(job.data.request.data.foo, requestPayload.foo)

        await boss.stop()
        finished()
      })

      const job = await boss.fetch(queueName)
      await boss.complete(job.id)
    }
  })

  it('onComplete should have both request and response', function (finished) {
    const config = this.test.bossConfig

    test()

    async function test () {
      const jobName = 'onCompleteFtw'
      const requestPayload = { token: 'trivial' }
      const responsePayload = { message: 'so verbose', code: '1234' }

      const boss = await helper.start(config)

      boss.onComplete(jobName, async job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual(job.data.request.data.token, requestPayload.token)
        assert.strictEqual(job.data.response.message, responsePayload.message)
        assert.strictEqual(job.data.response.code, responsePayload.code)

        await boss.stop()
        finished()
      })

      const jobId = await boss.publish(jobName, requestPayload)
      const job = await boss.fetch(jobName)

      await boss.complete(job.id, responsePayload)
    }
  })

  it('subscribe()\'s job.done() should allow sending completion payload', function (finished) {
    const config = this.test.bossConfig

    test()

    async function test () {
      const jobName = 'complete-from-subscribe'
      const responsePayload = { arg1: '123' }

      const boss = await helper.start(config)

      boss.onComplete(jobName, async job => {
        assert.strictEqual(job.data.response.arg1, responsePayload.arg1)
        await boss.stop()
        finished()
      })

      await boss.publish(jobName)

      boss.subscribe(jobName, job => job.done(null, responsePayload))
    }
  })

  it('should unsubscribe an onComplete subscription', async function () {
    const jobName = 'offComplete'

    let receivedCount = 0

    const boss = await helper.start(this.test.bossConfig)

    boss.onComplete(jobName, async job => {
      receivedCount++
      await boss.offComplete(jobName)
    })

    await boss.publish(jobName)
    const job1 = await boss.fetch(jobName)
    await boss.complete(job1.id)

    await Promise.delay(2000)

    await boss.publish(jobName)
    const job2 = await boss.fetch(jobName)
    await boss.complete(job2.id)

    await Promise.delay(2000)

    assert.strictEqual(receivedCount, 1)

    await boss.stop()
  })

  it('should fetch a completed job', async function () {
    const queue = 'fetchCompleted'

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publish(queue)
    await boss.fetch(queue)
    await boss.complete(jobId)
    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.request.id, jobId)

    await boss.stop()
  })

  it('should not create an extra state job after completion', async function () {
    const queue = 'noMoreExtraStateJobs'

    const boss = await helper.start(this.test.bossConfig)
    const jobId = await boss.publish(queue)

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    await boss.complete(job.id)

    const stateJobCount = await helper.countJobs('name = $1', [`${helper.completedJobPrefix}${queue}`])

    assert.strictEqual(stateJobCount, 1)

    await boss.stop()
  })
})
