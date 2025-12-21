import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { states } from '../src/index.ts'
import { testContext } from './hooks.ts'

describe('complete', function () {
  it('should reject missing id argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.complete(testContext.schema)
    })
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

    assert.strictEqual(activeCount, batchSize)

    const result = await testContext.boss.complete(testContext.schema, jobs.map(job => job.id))

    assert.strictEqual(batchSize, result.jobs.length)
  })

  it('should store job output in job.output from complete()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema)

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(jobId, job.id)

    const completionData = { msg: 'i am complete' }

    await testContext.boss.complete(testContext.schema, jobId, completionData)

    const jobWithMetadata = await testContext.boss.getJobById(testContext.schema, jobId)
    assert(jobWithMetadata)

    assert.strictEqual((jobWithMetadata as any).output.msg, completionData.msg)
  })

  it('should store job error in job.output from fail()', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema)

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(jobId, job.id)

    const completionError = new Error('i am complete')

    await testContext.boss.fail(testContext.schema, jobId, completionError)

    const jobWithMetadata = await testContext.boss.getJobById(testContext.schema, jobId)
    assert(jobWithMetadata)

    assert.strictEqual((jobWithMetadata as any).output.message, completionError.message)
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

    assert.strictEqual(activeCount, batchSize)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return (_db as any).pool.query(sql, values)
      }
    }

    const result = await testContext.boss.complete(testContext.schema, jobs.map(job => job.id), undefined, { db })

    assert.strictEqual(batchSize, result.jobs.length)
    assert.strictEqual(called, true)
  })
})
