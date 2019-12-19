const Promise = require('bluebird')
const assert = require('chai').assert
const helper = require('./testHelper')

describe('fetch', function () {
  this.timeout(10000)

  let boss

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('should reject missing queue argument', function (finished) {
    boss.fetch().catch(() => finished())
  })

  it('should fetch a job by name manually', async function () {
    const jobName = 'no-subscribe-required'

    await boss.publish(jobName)
    const job = await boss.fetch(jobName)
    assert(jobName === job.name)
  })

  it('should get a batch of jobs as an array', async function () {
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
  })
})
