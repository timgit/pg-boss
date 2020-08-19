const assert = require('assert')
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('expire', function () {
  const defaults = { maintenanceIntervalSeconds: 1 }

  it('should expire a job', async function () {
    const queue = 'expire'

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

  it('should expire a job - cascaded config', async function () {
    const queue = 'expire-cascade-config'

    const boss = await helper.start({ ...this.test.bossConfig, ...defaults, expireInSeconds: 1 })
    const jobId = await boss.publish(queue)

    // fetch the job but don't complete it
    await boss.fetch(queue)

    // this should give it enough time to expire
    await Promise.delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(jobId, job.data.request.id)
    assert.strictEqual('expired', job.data.state)

    await boss.stop()
  })

  it('should warn with an old expireIn option only once', async function () {
    const queue = 'expireIn-warning-only-once'

    const boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })

    let warningCount = 0

    const warningEvent = 'warning'
    const onWarning = (warning) => {
      assert(warning.message.includes('expireIn'))
      warningCount++
    }

    process.on(warningEvent, onWarning)

    await boss.publish({ name: queue, options: { expireIn: '1 minute' } })
    await boss.publish({ name: queue, options: { expireIn: '1 minute' } })
    await boss.publish({ name: queue, options: { expireIn: '1 minute' } })

    process.removeListener(warningEvent, onWarning)

    assert.strictEqual(warningCount, 1)

    await boss.stop()
  })
})
