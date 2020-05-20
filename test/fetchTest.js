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
    // Metadata should only be included when specifically requested
    assert(job.startedon === undefined)
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
    // Metadata should only be included when specifically requested
    assert(jobs[0].startedon === undefined)

    await boss.stop()
  })

  it('should fetch all metadata for a single job when requested', async function () {
    const jobName = 'fetch-include-metadata'

    const boss = await helper.start(this.test.bossConfig)
    await boss.publish(jobName)
    const job = await boss.fetch(jobName, undefined, true)
    assert(jobName === job.name)
    assert(job.priority === 0)
    assert(job.state === 'active')
    assert(job.retrylimit === 0)
    assert(job.retrycount === 0)
    assert(job.retrydelay === 0)
    assert(job.retrybackoff === false)
    assert(job.startafter !== undefined)
    assert(job.startedon !== undefined)
    assert(job.singletonkey === null)
    assert(job.singletonon === null)
    assert(job.expirein.minutes === 15)
    assert(job.createdon !== undefined)
    assert(job.completedon === null)
    assert(job.keepuntil !== undefined)
    await boss.stop()
  })

  it('should fetch all metadata for a batch of jobs when requested', async function () {
    const jobName = 'fetch-include-metadata-batch'
    const batchSize = 4

    const boss = await helper.start(this.test.bossConfig)

    await Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])

    const jobs = await boss.fetch(jobName, batchSize, true)
    assert(jobs.length === batchSize)

    jobs.forEach(job => {
      assert(jobName === job.name)
      assert(job.priority === 0)
      assert(job.state === 'active')
      assert(job.retrylimit === 0)
      assert(job.retrycount === 0)
      assert(job.retrydelay === 0)
      assert(job.retrybackoff === false)
      assert(job.startafter !== undefined)
      assert(job.startedon !== undefined)
      assert(job.singletonkey === null)
      assert(job.singletonon === null)
      assert(job.expirein.minutes === 15)
      assert(job.createdon !== undefined)
      assert(job.completedon === null)
      assert(job.keepuntil !== undefined)
    })
    await boss.stop()
  })
})
