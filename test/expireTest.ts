import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('expire', function () {
  it('should expire a job', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await testContext.boss.send(testContext.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    expect(jobId).toBeTruthy()

    const [job1] = await testContext.boss.fetch(testContext.schema)

    expect(job1).toBeTruthy()

    await delay(1000)

    await testContext.boss.supervise(testContext.schema)

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    expect(job!.state).toBe('failed')
  })

  it('should expire a job - cascaded config', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await testContext.boss.createQueue(testContext.schema, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await testContext.boss.send(testContext.schema)

    expect(jobId).toBeTruthy()

    // fetch the job but don't complete it
    await testContext.boss.fetch(testContext.schema)

    await delay(1000)

    await testContext.boss.supervise(testContext.schema)

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    expect(job!.state).toBe('failed')
  })

  it('should expire a job via supervise option', async function () {
    testContext.boss = await helper.start({
      ...testContext.bossConfig,
      noDefault: true,
      supervise: true,
      monitorIntervalSeconds: 1,
      superviseIntervalSeconds: 1
    })

    await testContext.boss.createQueue(testContext.schema, { expireInSeconds: 1, retryLimit: 0 })
    const jobId = await testContext.boss.send(testContext.schema)

    expect(jobId).toBeTruthy()

    // fetch the job but don't complete it
    await testContext.boss.fetch(testContext.schema)

    await delay(4000)

    const job = await testContext.boss.getJobById(testContext.schema, jobId)

    expect(job!.state).toBe('failed')
  })

  it('should abort signal when job handler times out', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await testContext.boss.send(testContext.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    expect(jobId).toBeTruthy()

    let signalAborted = false

    await testContext.boss.work(testContext.schema, async ([job]) => {
      job.signal.addEventListener('abort', () => {
        signalAborted = true
      })
      await delay(2000)
    })

    await delay(3000)

    expect(signalAborted).toBe(true)
  })
})
