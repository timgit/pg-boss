const assert = require('assert')
const helper = require('./testHelper')

describe('wildcard', function () {
  it('fetch() should return all jobs using a wildcard pattern', async function () {
    const queue = 'wildcard-fetch'

    const boss = await helper.start(this.test.bossConfig)
    await boss.publish(`${queue}_1234`)
    await boss.publish(`${queue}_5678`)

    const jobs = await boss.fetch(`${queue}_*`, 2)

    assert.strictEqual(jobs.length, 2)
  })

  it('subscribe() should return all jobs using a wildcard pattern', function (finished) {
    const baseName = 'wildcard-subscribe'
    const config = this.test.bossConfig

    test()

    async function test () {
      const boss = await helper.start(config)

      await boss.publish(`${baseName}_1234`)
      await boss.publish(`${baseName}_5678`)

      boss.subscribe(`${baseName}_*`, { batchSize: 2 }, jobs => {
        assert.strictEqual(jobs.length, 2)
        boss.stop(this.test.bossConfig.stopOptions).then(() => finished())
      })
    }
  })

  it('should not accidentally fetch state completion jobs from a pattern', async function () {
    const baseName = 'wildcard-fetch-incomplete'

    const boss = await helper.start(this.test.bossConfig)

    await boss.publish(`${baseName}_1234`)
    const job = await boss.fetch(`${baseName}_*`)
    await boss.complete(job.id)
    const job2 = await boss.fetch(`${baseName}_*`)

    assert.strictEqual(job2, null)
    await boss.stop(this.test.bossConfig.stopOptions)
  })
})
