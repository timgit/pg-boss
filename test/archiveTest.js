const assert = require('chai').assert
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('archive', function() {

  this.timeout(10000);

  let boss
  const config = { archiveCompletedJobsEvery:'1 second', archiveCheckInterval: 500 }

  before(async () => { boss = await helper.start(config) })
  after(() => boss.stop())

  it('should archive a job', async function() {

    const jobName = 'archiveMe'

    const jobId = await boss.publish(jobName)
    const job = await boss.fetch(jobName)
    
    assert.equal(job.id, jobId)

    await boss.complete(jobId)

    await Promise.delay(2000)

    const archivedJob = await helper.getArchivedJobById(jobId)
    
    assert.equal(jobId, archivedJob.id)
    assert.equal(jobName, archivedJob.name)
  })

})
