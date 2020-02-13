const assert = require('chai').assert
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('expire', function () {
  this.timeout(10000)

  let boss
  const config = { maintenanceIntervalSeconds: 1 }

  beforeEach(async function () { boss = await helper.start(config) })
  afterEach(async function () { await boss.stop() })

  it('should expire a job', async function () {
    const queue = 'i-take-too-long'

    const jobId = await boss.publish({ name: queue, options: { expireInSeconds: 1 } })

    // fetch the job but don't complete it
    await boss.fetch(queue)

    // this should give it enough time to expire
    await Promise.delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.equal(jobId, job.data.request.id)
    assert.equal('expired', job.data.state)
  })
})
