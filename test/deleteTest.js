import assert from 'node:assert'
import { delay } from '../src/tools.ts'
import { start } from './testHelper.js'

describe('delete', async () => {
  it('should delete a completed job via maintenance', async function () {
    const config = {
      ...this.test.bossConfig,
      maintenanceIntervalSeconds: 1
    }

    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { deleteAfterSeconds: 1 })
    await boss.fetch(queue)
    await boss.complete(queue, jobId)

    await delay(1000)

    await boss.supervise(queue)

    const job = await boss.getJobById(queue, jobId)

    assert(!job)
  })

  it('should delete a completed job via maintenance - cascade config from queue', async function () {
    const config = {
      ...this.test.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { deleteAfterSeconds: 1 })

    const jobId = await boss.send(queue)
    await boss.fetch(queue)
    await boss.complete(queue, jobId)

    await delay(1000)

    await boss.supervise(queue)

    const job = await boss.getJobById(queue, jobId)

    assert(!job)
  })

  it('should delete a job via deleteJob()', async function () {
    const config = { ...this.test.bossConfig }
    const boss = (this.test.boss = await start(config))
    const queue = config.schema

    const jobId = await boss.send(queue)

    await boss.fetch(queue)

    await boss.deleteJob(queue, jobId)

    const job = await boss.getJobById(queue, jobId)

    assert(!job)
  })
})
