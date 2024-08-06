const helper = require('./testHelper')
const assert = require('assert')

describe('speed', function () {
  const expectedSeconds = 9
  const jobCount = 10_000
  const queue = 'speedTest'
  const data = new Array(jobCount).fill(null).map((item, index) => ({ name: queue, data: { index } }))
  const testTitle = `should be able to fetch and complete ${jobCount} jobs in ${expectedSeconds} seconds`

  it(testTitle, async function () {
    this.timeout(expectedSeconds * 1000)
    this.slow(0)

    const config = { ...this.test.bossConfig, min: 10, max: 10, noDefault: true }
    const boss = this.test.boss = await helper.start(config)
    await boss.createQueue(queue)
    await boss.insert(data)
    const jobs = await boss.fetch(queue, { batchSize: jobCount })

    assert.strictEqual(jobCount, jobs.length)

    await boss.complete(queue, jobs.map(job => job.id))
  })
})
