const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('expire', function () {
  const defaults = { maintenanceIntervalSeconds: 1 }

  it('should expire a job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    boss.on('maintenance', () => { console.log(`${new Date().toISOString()}: on:maintenance event`) })

    await delay(10000)

    const queue = this.test.bossConfig.schema
    const deadLetter = `${queue}_dlq`
    const key = this.test.bossConfig.schema

    await boss.send({ name: queue, data: { key }, options: { expireInSeconds: 1, deadLetter } })

    const job1 = await boss.fetch(queue)

    assert(job1)

    await delay(3000)

    const job2 = await boss.fetch(queue)

    assert(job2)

    await delay(3000)

    const job3 = await boss.fetch(deadLetter)

    assert.strictEqual(key, job3.data.key)
  })

  it('should expire a job - cascaded config', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults, expireInSeconds: 1 })

    const queue = this.test.bossConfig.schema
    const deadLetter = `${queue}_dlq`

    const jobId = await boss.send(queue, { deadLetter })

    // fetch the job but don't complete it
    await boss.fetch(queue)

    await delay(3000)

    const { id } = await boss.fetch(queue)
    assert.strictEqual(id, jobId)

    await delay(3000)

    const job = await boss.getJobById(jobId)

    assert.strictEqual('failed', job.state)
  })
})
