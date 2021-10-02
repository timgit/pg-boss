const assert = require('assert')
const helper = require('./testHelper')

describe('wildcard', function () {
  it('fetch() should return all jobs using a wildcard pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'wildcard-fetch'

    await boss.publish(`${queue}_1234`)
    await boss.publish(`${queue}_5678`)

    const jobs = await boss.fetch(`${queue}_*`, 2)

    assert.strictEqual(jobs.length, 2)
  })

  it('subscribe() should return all jobs using a wildcard pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const baseName = 'wildcard-subscribe'

    await boss.publish(`${baseName}_1234`)
    await boss.publish(`${baseName}_5678`)

    return new Promise((resolve) => {
      boss.subscribe(`${baseName}_*`, { batchSize: 2 }, jobs => {
        assert.strictEqual(jobs.length, 2)
        resolve()
      })
    })
  })

  it('should not accidentally fetch state completion jobs from a pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const baseName = 'wildcard-fetch-incomplete'

    await boss.publish(`${baseName}_1234`)
    const job = await boss.fetch(`${baseName}_*`)
    await boss.complete(job.id)
    const job2 = await boss.fetch(`${baseName}_*`)

    assert.strictEqual(job2, null)
  })
})
