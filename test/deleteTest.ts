import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('delete', async function () {
  it('should delete a completed job via maintenance', async function () {
    const config = {
      ...this.bossConfig,
      maintenanceIntervalSeconds: 1
    }

    this.boss = await helper.start(config)

    const jobId = await this.boss.send(this.schema, null, { deleteAfterSeconds: 1 })
    await this.boss.fetch(this.schema)
    await this.boss.complete(this.schema, jobId)

    await delay(1000)

    await this.boss.supervise(this.schema)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert(!job)
  })

  it('should delete a completed job via maintenance - cascade config from queue', async function () {
    const config = {
      ...this.bossConfig,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    this.boss = await helper.start(config)

    await this.boss.createQueue(this.schema, { deleteAfterSeconds: 1 })

    const jobId = await this.boss.send(this.schema)
    await this.boss.fetch(this.schema)
    await this.boss.complete(this.schema, jobId)

    await delay(1000)

    await this.boss.supervise(this.schema)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert(!job)
  })

  it('should delete a job via deleteJob()', async function () {
    const config = { ...this.bossConfig }
    this.boss = await helper.start(config)

    const jobId = await this.boss.send(this.schema)

    await this.boss.fetch(this.schema)

    await this.boss.deleteJob(this.schema, jobId)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert(!job)
  })
})
