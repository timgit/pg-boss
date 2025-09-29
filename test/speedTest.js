import { strictEqual } from 'node:assert'
import { start } from './testHelper.js'

describe('speed', () => {
  const expectedSeconds = 9
  const jobCount = 5_000
  const queue = 'speedTest'
  const data = new Array(jobCount)
    .fill(null)
    .map((_item, index) => ({ name: queue, data: { index } }))
  const testTitle = `should be able to fetch and complete ${jobCount} jobs in ${expectedSeconds} seconds`

  it(testTitle, async function () {
    this.timeout(expectedSeconds * 1000)
    this.slow(0)

    const config = {
      ...this.test.bossConfig,
      min: 10,
      max: 10,
      noDefault: true
    }
    const boss = (this.test.boss = await start(config))
    await boss.createQueue(queue)
    await boss.insert(queue, data)
    const jobs = await boss.fetch(queue, { batchSize: jobCount })

    strictEqual(jobCount, jobs.length)

    await boss.complete(
      queue,
      jobs.map((job) => job.id)
    )
  })
})
