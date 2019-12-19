const assert = require('chai').assert
const helper = require('./testHelper')

describe('cancel', function () {
  this.timeout(10000)

  let boss

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('should reject missing id argument', function (finished) {
    boss.cancel().catch(() => finished())
  })

  it('should cancel a pending job', async function () {
    const jobId = await boss.publish('will_cancel', null, { startAfter: 1 })

    await boss.cancel(jobId)

    const job = await helper.getJobById(jobId)

    assert(job && job.state === 'cancelled')
  })

  it('should not cancel a completed job', function (finished) {
    boss.publish('will_not_cancel')

    boss.subscribe('will_not_cancel', async job => {
      await job.done()
      const response = await boss.cancel(job.id)
      assert.strictEqual(response.updated, 0)
      finished()
    })
  })

  it('should cancel a batch of jobs', async function () {
    const queue = 'cancel-batch'

    const jobs = await Promise.all([
      boss.publish(queue),
      boss.publish(queue),
      boss.publish(queue)
    ])

    await boss.cancel(jobs)
  })
})
