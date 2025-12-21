import * as helper from './testHelper.ts'
import assert from 'node:assert'
import { testContext } from './hooks.ts'
import { it } from 'vitest'

describe('speed', function () {
  const jobCount = 5_000
  const queue = 'speedTest'
  const data = new Array(jobCount).fill(null).map((item, index) => ({ name: queue, data: { index } }))

  it(`should be able to fetch and complete ${jobCount} jobs in 9 seconds`, { timeout: 9000 }, async function () {
    const config = { ...testContext.bossConfig, min: 10, max: 10, noDefault: true }
    testContext.boss = await helper.start(config)
    await testContext.boss.createQueue(queue)
    await testContext.boss.insert(queue, data)
    const jobs = await testContext.boss.fetch(queue, { batchSize: jobCount })

    assert.strictEqual(jobCount, jobs.length)

    await testContext.boss.complete(queue, jobs.map(job => job.id))
  })
})
