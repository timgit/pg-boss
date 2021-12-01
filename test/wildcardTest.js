const assert = require('assert')
const helper = require('./testHelper')

describe('wildcard', function () {
  it('fetch() should return all jobs using a wildcard pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}_1234`)
    await boss.send(`${queue}_5678`)

    const jobs = await boss.fetch(`${queue}_*`, 2)

    assert.strictEqual(jobs.length, 2)
  })

  it('work() should return all jobs using a wildcard pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}_1234`)
    await boss.send(`${queue}_5678`)

    return new Promise((resolve) => {
      boss.work(`${queue}_*`, { batchSize: 2 }, jobs => {
        assert.strictEqual(jobs.length, 2)
        resolve()
      })
    })
  })

  it('should not accidentally fetch state completion jobs from a pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}_1234`)
    const job = await boss.fetch(`${queue}_*`)
    await boss.complete(job.id)
    const job2 = await boss.fetch(`${queue}_*`)

    assert.strictEqual(job2, null)
  })
})
