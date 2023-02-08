const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')
const { states } = require('../src/plans')

describe('archive', function () {
  const defaults = {
    archiveCompletedAfterSeconds: 1,
    maintenanceIntervalSeconds: 1
  }

  it('should archive a completed job', async function () {
    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(jobId)

    await delay(4000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
  })

  it('should retrieve an archived job via getJobById()', async function () {
    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(jobId)

    await delay(4000)

    const archivedJob = await boss.getJobById(jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
  })

  it('should archive a created job', async function () {
    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retentionSeconds: 1 })

    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
  })

  it('should archive a created job - cascaded config', async function () {
    const config = { ...this.test.bossConfig, ...defaults, retentionSeconds: 1 }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
  })

  it('should not archive a failed job before the config setting', async function () {
    const config = { ...this.test.bossConfig, ...defaults, archiveFailedAfterSeconds: 10 }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const failPayload = { someReason: 'nuna' }
    const jobId = await boss.send(queue, null, { retentionSeconds: 1 })

    await boss.fail(jobId, failPayload)
    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(archivedJob, null)
  })

  it('should archive a failed job', async function () {
    const config = { ...this.test.bossConfig, maintenanceIntervalSeconds: 1, archiveFailedAfterSeconds: 1 }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const failPayload = { someReason: 'nuna' }
    const jobId = await boss.send(queue, null, { retentionSeconds: 1 })

    await boss.fail(jobId, failPayload)
    await delay(7000)

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
    assert.strictEqual(states.failed, archivedJob.state)
  })
})
