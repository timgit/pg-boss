import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('cancel', function () {
  it('should reject missing arguments', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await testContext.boss.cancel()
    }).rejects.toThrow()
  })

  it('should cancel a pending job', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema, {}, { startAfter: 1 })

    await testContext.boss.cancel(testContext.schema, jobId!)

    const job = await testContext.boss.getJobById(testContext.schema, jobId!)

    expect(job && job.state === 'cancelled').toBeTruthy()
  })

  it('should not cancel a completed job', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)

    const [job] = await testContext.boss.fetch(testContext.schema)

    const completeResult = await testContext.boss.complete(testContext.schema, job.id)

    expect(completeResult.affected).toBe(1)

    const cancelResult = await testContext.boss.cancel(testContext.schema, job.id)

    expect(cancelResult.affected).toBe(0)
  })

  it('should cancel a batch of jobs', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobs = await Promise.all([
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema)
    ])

    await testContext.boss.cancel(testContext.schema, jobs as string[])
  })

  it('should cancel a pending job with custom connection', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return (_db as any).pool.query(sql, values)
      }
    }

    const jobId = await testContext.boss.send(testContext.schema, {}, { startAfter: 1 })

    await testContext.boss.cancel(testContext.schema, jobId!, { db })

    const job = await testContext.boss.getJobById(testContext.schema, jobId!)

    expect(job && job.state === 'cancelled').toBeTruthy()
    expect(called).toBe(true)
  })
})
