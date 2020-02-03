const assert = require('chai').assert
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('delete', async function () {
  this.timeout(10000)

  let boss

  const config = {
    archiveCompletedJobsEvery: '1 second',
    deleteArchivedJobsEvery: '1 second',
    maintenanceIntervalSeconds: 1
  }

  before(async function () { boss = await helper.start(config) })
  after(async function () { await boss.stop() })

  it('should delete an archived job', async function () {
    const jobName = 'deleteMe'
    const jobId = await boss.publish(jobName)
    const job = await boss.fetch(jobName)

    assert.equal(jobId, job.id)

    await boss.complete(jobId)

    await Promise.delay(4000)

    const archivedJob = await helper.getArchivedJobById(jobId)

    assert.strictEqual(archivedJob, null)
  })
})
