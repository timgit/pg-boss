const assert = require('assert')
const helper = require('./testHelper')
const { delay } = require('../src/tools')
const { states } = require('../src/plans')

describe('archive', function () {
  const defaults = {
    archiveCompletedAfterSeconds: 1,
    supervise: true
  }

  it('should archive a completed job', async function () {
    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(queue, jobId)

    await delay(1000)

    await boss.maintain()

    const archivedJob = await helper.getArchivedJobById(config.schema, queue, jobId)

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

    await boss.complete(queue, jobId)

    await delay(1000)

    await boss.maintain()

    const archivedJob = await boss.getJobById(queue, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
  })

  it('should archive a created job', async function () {
    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retentionSeconds: 1 })

    await delay(1000)

    await boss.maintain()

    const archivedJob = await helper.getArchivedJobById(config.schema, queue, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
  })

  it('should archive a created job - cascaded config', async function () {
    const config = { ...this.test.bossConfig, ...defaults, retentionSeconds: 1 }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    await delay(1000)

    await boss.maintain()

    const archivedJob = await helper.getArchivedJobById(config.schema, queue, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
  })

  it('should not archive a failed job before the config setting', async function () {
    const config = { ...this.test.bossConfig, ...defaults, archiveFailedAfterSeconds: 10 }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const failPayload = { someReason: 'nuna' }
    const jobId = await boss.send(queue, null, { retentionSeconds: 1 })

    await boss.fail(queue, jobId, failPayload)

    await delay(1000)

    await boss.maintain()

    const archivedJob = await helper.getArchivedJobById(config.schema, queue, jobId)

    assert.strictEqual(archivedJob, null)
  })

  it('should archive a failed job', async function () {
    const config = { ...this.test.bossConfig, archiveFailedAfterSeconds: 1 }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const failPayload = { someReason: 'nuna' }
    const jobId = await boss.send(queue, null, { retentionSeconds: 1 })

    await boss.fail(queue, jobId, failPayload)

    await delay(1000)

    await boss.maintain()

    const archivedJob = await helper.getArchivedJobById(config.schema, queue, jobId)

    assert.strictEqual(jobId, archivedJob.id)
    assert.strictEqual(queue, archivedJob.name)
    assert.strictEqual(states.failed, archivedJob.state)
  })
})
