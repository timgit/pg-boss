const assert = require('assert')
const helper = require('./testHelper')

describe('fetch', function () {
  it('should reject missing queue argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.fetch()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fetch a job by name manually', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const jobName = 'no-subscribe-required'

    await boss.publish(jobName)
    const job = await boss.fetch(jobName)
    assert(jobName === job.name)
    // Metadata should only be included when specifically requested
    assert(job.startedon === undefined)
  })

  it('should get a batch of jobs as an array', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const jobName = 'fetch-batch'
    const batchSize = 4

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
  })

  it('should fetch all metadata for a single job when requested', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const jobName = 'fetch-include-metadata'

    await boss.publish(jobName)
    const job = await boss.fetch(jobName, undefined, { includeMetadata: true })
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

  it('should fetch all metadata for a batch of jobs when requested', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const jobName = 'fetch-include-metadata-batch'
    const batchSize = 4

    await Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])

    const jobs = await boss.fetch(jobName, batchSize, { includeMetadata: true })
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
  })
})
