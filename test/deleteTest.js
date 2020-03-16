const assert = require('assert')
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('delete', async function () {
  const defaults = {
    archiveIntervalSeconds: 1,
    deleteIntervalSeconds: 1,
    maintenanceIntervalSeconds: 1
  }

  it('should delete an archived job', async function () {
    const jobName = 'deleteMe'

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = await helper.start(config)
    const jobId = await boss.publish(jobName)
    const job = await boss.fetch(jobName)

    assert.strictEqual(jobId, job.id)

    await boss.complete(jobId)

    await Promise.delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(archivedJob, null)

    await boss.stop()
  })
})
