import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('expire', function () {
  it('should expire a job', async function () {
    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await this.boss.send(this.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    assert(jobId)

    const [job1] = await this.boss.fetch(this.schema)

    assert(job1)

    await delay(1000)

    await this.boss.supervise(this.schema)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert.strictEqual('failed', job!.state)
  })

  it('should expire a job - cascaded config', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await this.boss.createQueue(this.schema, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    // fetch the job but don't complete it
    await this.boss.fetch(this.schema)

    await delay(1000)

    await this.boss.supervise(this.schema)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert.strictEqual('failed', job!.state)
  })

  it('should expire a job via supervise option', async function () {
    this.boss = await helper.start({
      ...this.bossConfig,
      noDefault: true,
      supervise: true,
      monitorIntervalSeconds: 1,
      superviseIntervalSeconds: 1
    })

    await this.boss.createQueue(this.schema, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await this.boss.send(this.schema)

    assert(jobId)

    // fetch the job but don't complete it
    await this.boss.fetch(this.schema)

    await delay(4000)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert.strictEqual('failed', job!.state)
  })

  it('should abort signal when job handler times out', async function () {
    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await this.boss.send(this.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    assert(jobId)

    let signalAborted = false

    await this.boss.work(this.schema, async ([job]) => {
      job.signal.addEventListener('abort', () => {
        signalAborted = true
      })
      await delay(2000)
    })

    await delay(3000)

    assert.strictEqual(signalAborted, true)
  })
})
