const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('expire', function () {
  const defaults = { maintenanceIntervalSeconds: 1 }

  it('should expire a job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults, onComplete: true })

    const queue = 'expire'

    const jobId = await boss.send({ name: queue, options: { expireInSeconds: 1 } })

    // fetch the job but don't complete it
    await boss.fetch(queue)

    // this should give it enough time to expire
    await delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(jobId, job.data.request.id)
    assert.strictEqual('expired', job.data.state)
  })

  it('should expire a job - cascaded config', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults, expireInSeconds: 1 })

    const queue = 'expire-cascade-config'

    const jobId = await boss.send(queue)

    // fetch the job but don't complete it
    const { id } = await boss.fetch(queue)

    assert.strictEqual(jobId, id)

    // this should give it enough time to expire
    await delay(8000)

    const job = await boss.getJobById(jobId)

    assert.strictEqual('expired', job.state)
  })

  it('should warn with an old expireIn option only once', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })

    const queue = 'expireIn-warning-only-once'

    let warningCount = 0

    const warningEvent = 'warning'
    const onWarning = (warning) => {
      assert(warning.message.includes('expireIn'))
      warningCount++
    }

    process.on(warningEvent, onWarning)

    await boss.send({ name: queue, options: { expireIn: '1 minute' } })
    await boss.send({ name: queue, options: { expireIn: '1 minute' } })
    await boss.send({ name: queue, options: { expireIn: '1 minute' } })

    process.removeListener(warningEvent, onWarning)

    assert.strictEqual(warningCount, 1)
  })
})
