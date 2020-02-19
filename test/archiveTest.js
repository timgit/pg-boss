const assert = require('chai').assert
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('archive', function () {
  this.timeout(10000)

  let boss

  const config = {
    archiveIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1
  }

  before(async function () { boss = await helper.start(config) })
  after(async function () { await boss.stop() })

  it('should archive a completed job', async function () {
    const jobName = 'archive-completed'

    const jobId = await boss.publish(jobName)
    const job = await boss.fetch(jobName)

    assert.equal(job.id, jobId)

    await boss.complete(jobId)

    await Promise.delay(3000)

    const archivedJob = await helper.getArchivedJobById(jobId)

    assert.equal(jobId, archivedJob.id)
    assert.equal(jobName, archivedJob.name)
  })

  it('should archive a created job', async function () {
    const jobName = 'archive-created'

    const jobId = await boss.publish(jobName, null, { retentionSeconds: 1 })

    await Promise.delay(5000)

    const archivedJob = await helper.getArchivedJobById(jobId)

    assert.equal(jobId, archivedJob.id)
    assert.equal(jobName, archivedJob.name)
  })
})
