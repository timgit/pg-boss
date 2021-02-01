const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')
const PgBoss = require('../')

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
    const queue = 'complete-batch'
    const batchSize = 3

    const boss = await helper.start(this.test.bossConfig)

    await Promise.all([
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ])

    const countJobs = (state) => helper.countJobs(this.test.bossConfig.schema, 'name = $1 AND state = $2', [queue, state])

    const jobs = await boss.fetch(queue, batchSize)

    const activeCount = await countJobs(PgBoss.states.active)

    assert.strictEqual(activeCount, batchSize)

    await boss.complete(jobs.map(job => job.id))

    const completed = await boss.fetchCompleted(queue, batchSize)

    assert.strictEqual(batchSize, completed.length)

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

    await delay(2000)

    await boss.publish(jobName)
    const job2 = await boss.fetch(jobName)
    await boss.complete(job2.id)

    await delay(2000)

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
    const config = this.test.bossConfig

    const boss = await helper.start(config)
    const jobId = await boss.publish(queue)

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    await boss.complete(job.id)

    const stateJobCount = await helper.countJobs(config.schema, 'name = $1', [`${helper.completedJobPrefix}${queue}`])

    assert.strictEqual(stateJobCount, 1)

    await boss.stop()
  })

  it('should not create a completion job if opted out during publish', async function () {
    const queue = 'onCompleteOptOut'

    const config = this.test.bossConfig

    const boss = await helper.start(config)

    const jobId = await boss.publish(queue, null, { onComplete: false })

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job, null)

    await boss.stop()
  })

  it('should not create a completion job if opted out during constructor', async function () {
    const queue = 'onCompleteOptOutGlobal'

    const config = this.test.bossConfig

    const boss = await helper.start({ ...config, onComplete: false })

    const jobId = await boss.publish(queue)

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job, null)

    await boss.stop()
  })

  it('should create completion job if overriding the default from constructor', async function () {
    const queue = 'onCompleteOptInOverride'

    const config = this.test.bossConfig

    const boss = await helper.start({ ...config, onComplete: false })

    const jobId = await boss.publish(queue, null, { onComplete: true })

    await boss.fetch(queue)

    await boss.complete(jobId)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.request.id, jobId)

    await boss.stop()
  })
})
