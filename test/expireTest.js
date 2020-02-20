const assert = require('assert')
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('expire', function () {
  const defaults = { maintenanceIntervalSeconds: 1 }

  it('should expire a job', async function () {
    const queue = 'i-take-too-long'

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const jobId = await boss.publish({ name: queue, options: { expireInSeconds: 1 } })

    // fetch the job but don't complete it
    await boss.fetch(queue)

    // this should give it enough time to expire
    await Promise.delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(jobId, job.data.request.id)
    assert.strictEqual('expired', job.data.state)

    await boss.stop()
  })
})
