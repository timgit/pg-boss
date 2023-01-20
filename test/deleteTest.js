const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('delete', async function () {
  const defaults = {
    deleteAfterSeconds: 2,
    archiveCompletedAfterSeconds: 1,
    maintenanceIntervalSeconds: 1
  }

  it('should delete an archived job', async function () {
    const jobName = 'deleteMe'

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = await helper.start(config)
    const jobId = await boss.send(jobName)
    const job = await boss.fetch(jobName)

    assert.strictEqual(jobId, job.id)
    await boss.complete(jobId)
    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(archivedJob, null)
  })

  it('should delete an archived job and trigger after-purge', async function () {
    const jobName = 'deleteMe'

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = await helper.start(config)
    const jobId = await boss.send(jobName)
    const job = await boss.fetch(jobName)
    const purgePromise = new Promise(resolve => this.test.boss.once('after-purge', (jobIds) => {
      return resolve(jobIds)
    }))

    assert.strictEqual(jobId, job.id)
    await boss.complete(jobId)
    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(archivedJob, null)
    const deletedJobIds = await purgePromise
    assert.strictEqual(deletedJobIds.includes(jobId), true)
  })
})
