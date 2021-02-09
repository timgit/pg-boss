const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('archive', function () {
  const defaults = {
    archiveCompletedAfterSeconds: 1,
    maintenanceIntervalSeconds: 1
  }

  it('should archive a completed job', async function () {
    const config = { ...this.test.bossConfig, ...defaults }
    const boss = await helper.start(config)
    const queue = 'archive-completed'

    const jobId = await boss.publish(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(jobId)

    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)

    await boss.stop()
  })

  it('should archive a created job', async function () {
    const config = { ...this.test.bossConfig, ...defaults }
    const boss = await helper.start(config)

    const queue = 'archive-created'

    const jobId = await boss.publish(queue, null, { retentionSeconds: 1 })

    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)

    await boss.stop()
  })

  it('should archive a created job - cascaded config', async function () {
    const config = { ...this.test.bossConfig, ...defaults, retentionSeconds: 1 }
    const boss = await helper.start(config)

    const queue = 'archive-created-cascaded-config'

    const jobId = await boss.publish(queue)

    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)

    await boss.stop()
  })
})
