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
      await boss.stop()
    }
  })

  it('should cancel a pending job', async function () {
    const boss = await helper.start(this.test.bossConfig)

    const jobId = await boss.publish('will_cancel', null, { startAfter: 1 })

    await boss.cancel(jobId)

    const job = await helper.getJobById(jobId)

    assert(job && job.state === 'cancelled')

    await boss.stop()
  })

  it('should not cancel a completed job', function (finished) {
    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)
      await boss.publish('will_not_cancel')

      boss.subscribe('will_not_cancel', async job => {
        await job.done()
        const response = await boss.cancel(job.id)
        assert.strictEqual(response.updated, 0)
        await boss.stop()
        finished()
      })
    }
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

    await boss.stop()
  })
})
