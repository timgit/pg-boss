import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('cancel', function () {
  it('should reject missing id argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await testContext.boss.resume()
    }).rejects.toThrow()
  })

  it('should cancel and resume a pending job', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema, null, { startAfter: 1 })

    expect(jobId).toBeTruthy()

    await testContext.boss.cancel(testContext.schema, jobId!)

    const job = await testContext.boss.getJobById(testContext.schema, jobId!)

    expect(job && job.state === 'cancelled').toBeTruthy()

    await testContext.boss.resume(testContext.schema, jobId!)

    const job2 = await testContext.boss.getJobById(testContext.schema, jobId!)

    expect(job2 && job2.state === 'created').toBeTruthy()
  })

  it('should cancel and resume a pending job with custom connection', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const jobId = await testContext.boss.send(testContext.schema, null, { startAfter: 1 })

    expect(jobId).toBeTruthy()

    let callCount = 0
    const _db = await helper.getDb()
    const db = {
      // @ts-ignore
      async executeSql (sql, values) {
        callCount++
        // @ts-ignore
        return _db.pool.query(sql, values)
      }
    }

    await testContext.boss.cancel(testContext.schema, jobId!, { db })

    const job = await testContext.boss.getJobById(testContext.schema, jobId!, { db })

    expect(job && job.state === 'cancelled').toBeTruthy()

    await testContext.boss.resume(testContext.schema, jobId!, { db })

    const job2 = await testContext.boss.getJobById(testContext.schema, jobId!, { db })

    expect(job2 && job2.state === 'created').toBeTruthy()
    expect(callCount).toBe(4)
  })
})
