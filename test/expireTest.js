const assert = require('node:assert')
const helper = require('./testHelper')
const { delay } = require('../src/tools')

describe('expire', function () {
  it('should expire a job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, monitorIntervalSeconds: 1 })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 0, expireInSeconds: 1 })

    assert(jobId)

    const [job1] = await boss.fetch(queue)

    assert(job1)

    await delay(1000)

    await boss.maintain(queue)

    const job = await boss.getJobById(queue, jobId)

    assert.strictEqual('failed', job.state)
  })

  it('should expire a job - cascaded config', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await boss.send(queue)

    // fetch the job but don't complete it
    await boss.fetch(queue)

    await delay(1000)

    await boss.maintain()

    const job = await boss.getJobById(queue, jobId)

    assert.strictEqual('failed', job.state)
  })
})
