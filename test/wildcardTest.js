const assert = require('chai').assert
const helper = require('./testHelper')

describe('wildcard', function () {
  this.timeout(10000)

  let boss

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('fetch() should return all jobs using a wildcard pattern', async function () {
    const baseName = 'wildcard-fetch'

    await boss.publish(`${baseName}_1234`)
    await boss.publish(`${baseName}_5678`)

    const jobs = await boss.fetch(`${baseName}_*`, 2)

    assert.strictEqual(jobs.length, 2)
  })

  it('subscribe() should return all jobs using a wildcard pattern', function (finished) {
    const baseName = 'wildcard-subscribe'

    test()

    async function test () {
      await boss.publish(`${baseName}_1234`)
      await boss.publish(`${baseName}_5678`)

      boss.subscribe(`${baseName}_*`, { batchSize: 2 }, jobs => {
        assert.strictEqual(jobs.length, 2)
        finished()
      })
    }
  })

  it('should not accidentally fetch state completion jobs from a pattern', async function () {
    const baseName = 'wildcard-fetch-incomplete'

    await boss.publish(`${baseName}_1234`)
    const job = await boss.fetch(`${baseName}_*`)
    await boss.complete(job.id)
    const job2 = await boss.fetch(`${baseName}_*`)

    assert.strictEqual(job2, null)
  })
})
