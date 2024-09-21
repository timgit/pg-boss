const assert = require('node:assert')
const helper = require('./testHelper')
const { delay } = require('../src/tools')

describe('delete', async function () {
  it('should delete a completed job via maintenance', async function () {
    const config = {
      ...this.test.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { deletionSeconds: 1 })

    const jobId = await boss.send(queue)
    await boss.fetch(queue)
    await boss.complete(queue, jobId)

    await delay(1000)

    await boss.maintain(queue)

    const job = await boss.getJobById(queue, jobId)

    assert(!job)
  })

  it('should delete a job via deleteJob()', async function () {
    const config = { ...this.test.bossConfig }
    const boss = this.test.boss = await helper.start(config)
    const queue = config.schema

    const jobId = await boss.send(queue)

    await boss.fetch(queue)

    await boss.deleteJob(queue, jobId)

    const job = await boss.getJobById(queue, jobId)

    assert(!job)
  })
})
