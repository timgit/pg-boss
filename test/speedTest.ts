import * as helper from './testHelper.ts'
import assert from 'node:assert'

describe('speed', function () {
  const expectedSeconds = 9
  const jobCount = 5_000
  const queue = 'speedTest'
  const data = new Array(jobCount).fill(null).map((item, index) => ({ name: queue, data: { index } }))
  const testTitle = `should be able to fetch and complete ${jobCount} jobs in ${expectedSeconds} seconds`

  it(testTitle, async function () {
    this.timeout(expectedSeconds * 1000)
    this.slow(0)

    const config = { ...this.bossConfig, min: 10, max: 10, noDefault: true }
    this.boss = await helper.start(config)
    await this.boss.createQueue(queue)
    await this.boss.insert(queue, data)
    const jobs = await this.boss.fetch(queue, { batchSize: jobCount })

    assert.strictEqual(jobCount, jobs.length)

    await this.boss.complete(queue, jobs.map(job => job.id))
  })
})
