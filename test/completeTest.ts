import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { states } from '../src/index.ts'
import { testContext } from './hooks.ts'

describe('complete', function () {
  it('should reject missing id argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await testContext.boss.complete(testContext.schema)
    }).rejects.toThrow()
  })

  it('should complete a batch of jobs', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const batchSize = 3

    await Promise.all([
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema)
    ])

    const { table } = (await testContext.boss.getQueue(testContext.schema))!

    const countJobs = (state: string) => helper.countJobs(testContext.schema, table, 'name = $1 AND state = $2', [testContext.schema, state])

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize })

    const activeCount = await countJobs(states.active)

    expect(activeCount).toBe(batchSize)

    const result = await testContext.boss.complete(testContext.schema, jobs.map(job => job.id))

    expect(result.jobs.length).toBe(batchSize)
  })

  it('should store job output in job.output from complete()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema)

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job.id).toBe(jobId)

    const completionData = { msg: 'i am complete' }

    await testContext.boss.complete(testContext.schema, jobId, completionData)

    const jobWithMetadata = await testContext.boss.getJobById(testContext.schema, jobId)
    expect(jobWithMetadata).toBeTruthy()

    expect((jobWithMetadata as any).output.msg).toBe(completionData.msg)
  })

  it('should store job error in job.output from fail()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema)

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job.id).toBe(jobId)

    const completionError = new Error('i am complete')

    await testContext.boss.fail(testContext.schema, jobId, completionError)

    const jobWithMetadata = await testContext.boss.getJobById(testContext.schema, jobId)
    expect(jobWithMetadata).toBeTruthy()

    expect((jobWithMetadata as any).output.message).toBe(completionError.message)
  })

  it('should complete a batch of jobs with custom connection', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const batchSize = 3

    await Promise.all([
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema)
    ])

    const { table } = (await testContext.boss.getQueue(testContext.schema))!

    const countJobs = (state: string) => helper.countJobs(testContext.schema, table, 'name = $1 AND state = $2', [testContext.schema, state])

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize })

    const activeCount = await countJobs(states.active)

    expect(activeCount).toBe(batchSize)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return (_db as any).pool.query(sql, values)
      }
    }

    const result = await testContext.boss.complete(testContext.schema, jobs.map(job => job.id), undefined, { db })

    expect(result.jobs.length).toBe(batchSize)
    expect(called).toBe(true)
  })
})
