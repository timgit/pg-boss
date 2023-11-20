const assert = require('assert')
const helper = require('./testHelper')

describe('updateStartAfter', function () {
  it('should edit the startAfter date of a job', async function () {
    const config = this.test.bossConfig
    const boss = this.test.boss = await helper.start(config)

    const originalDate = new Date()
    const newDate = new Date(originalDate.setMonth(originalDate.getMonth() + 1))

    const jobId = await boss.send('start_after_date_should_change', null, { startAfter: originalDate })

    await boss.updateStartAfterDate(jobId, newDate)

    const job = await boss.getJobById(jobId)

    const jobStartAfterDateMs = new Date(job.startafter).getTime()
    const newDateMs = newDate.getTime()

    assert.strictEqual(jobStartAfterDateMs, newDateMs)
  })

  it('should throw an error if date is not valid', async function () {
    const config = this.test.bossConfig
    const boss = this.test.boss = await helper.start(config)

    const queue = 'invalid_start_after_date_should_throw_error'

    const id = await boss.send(queue)

    const newDate = "I'm not a date!"

    try {
      await boss.updateStartAfterDate(id, newDate)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should not update a completed job', async function () {
    const config = this.test.bossConfig
    const boss = this.test.boss = await helper.start(config)

    const queue = 'will_not_update_start_after_date'

    const newDate = new Date(Date.now() + 10000)

    await boss.send(queue)

    const fetchedJob = await boss.fetch(queue)

    await boss.complete(fetchedJob.id)

    const response = await boss.updateStartAfterDate(fetchedJob.id, newDate)

    assert.strictEqual(response.updated, 0)
  })
})
