const Promise = require('bluebird')
const assert = require('assert')
const helper = require('./testHelper')

describe('fetch', function () {
  it('should reject missing queue argument', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.fetch()
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should fetch a job by name manually', async function () {
    const jobName = 'no-subscribe-required'

    const boss = await helper.start(this.test.bossConfig)
    await boss.publish(jobName)
    const job = await boss.fetch(jobName)
    assert(jobName === job.name)
    await boss.stop()
  })

  it('should get a batch of jobs as an array', async function () {
    const jobName = 'fetch-batch'
    const batchSize = 4

    const boss = await helper.start(this.test.bossConfig)

    await Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])

    const jobs = await boss.fetch(jobName, batchSize)

    assert(jobs.length === batchSize)

    await boss.stop()
  })
})
