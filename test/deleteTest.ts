import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('delete', function () {
  it('should delete a completed job via maintenance', async function () {
    const config = {
      ...testContext.bossConfig,
      maintenanceIntervalSeconds: 1
    }

    testContext.boss = await helper.start(config)

    const jobId = await testContext.boss.send(testContext.schema, null, { deleteAfterSeconds: 1 })

    assert(jobId)

    await testContext.boss.fetch(testContext.schema)
    await testContext.boss.complete(testContext.schema, jobId)

    await delay(1000)

    await testContext.boss.supervise(testContext.schema)

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert(!job)
  })

  it('should delete a completed job via maintenance - cascade config from queue', async function () {
    const config = {
      ...testContext.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.createQueue(testContext.schema, { deleteAfterSeconds: 1 })

    const jobId = await testContext.boss.send(testContext.schema)
    assert(jobId)
    await testContext.boss.fetch(testContext.schema)
    await testContext.boss.complete(testContext.schema, jobId)

    await delay(1000)

    await testContext.boss.supervise(testContext.schema)

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert(!job)
  })

  it('should delete a job via deleteJob()', async function () {
    const config = { ...testContext.bossConfig }
    testContext.boss = await helper.start(config)

    const jobId = await testContext.boss.send(testContext.schema)

    assert(jobId)

    await testContext.boss.fetch(testContext.schema)

    await testContext.boss.deleteJob(testContext.schema, jobId)

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    assert(!job)
  })
})
