const assert = require('assert')
const helper = require('./testHelper')

describe('delete', async function () {
  it('should delete an archived job', async function () {
    const config = { ...this.test.bossConfig, deleteAfterSeconds: 1 }
    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    await boss.fetch(queue)

    await boss.complete(jobId)

    await boss.maintain()

    const archivedJob = await helper.getArchivedJobById(config.schema, jobId)

    assert.strictEqual(archivedJob, null)
  })
})
