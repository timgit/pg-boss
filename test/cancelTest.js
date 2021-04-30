const assert = require('assert')
const helper = require('./testHelper')

describe('cancel', function () {
  it('should reject missing id argument', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.cancel()
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop(this.test.bossConfig.stopOptions)
    }
  })

  it('should cancel a pending job', async function () {
    const config = this.test.bossConfig
    const boss = await helper.start(config)

    const jobId = await boss.publish('will_cancel', null, { startAfter: 1 })

    await boss.cancel(jobId)

    const job = await helper.getJobById(config.schema, jobId)

    assert(job && job.state === 'cancelled')

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should not cancel a completed job', async function () {
    const config = this.test.bossConfig

    const boss = await helper.start(config)

    const queue = 'will_not_cancel'

    await boss.publish(queue)

    const job = await boss.fetch(queue)

    await boss.complete(job.id)

    const response = await boss.cancel(job.id)

    assert.strictEqual(response.updated, 0)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should cancel a batch of jobs', async function () {
    const queue = 'cancel-batch'

    const boss = await helper.start(this.test.bossConfig)
    const jobs = await Promise.all([
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ])

    await boss.cancel(jobs)

    await boss.stop(this.test.bossConfig.stopOptions)
  })
})
