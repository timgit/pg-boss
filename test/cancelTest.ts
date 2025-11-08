import assert from 'node:assert'
import * as helper from './testHelper.ts'
import type { TestContext } from './hooks.ts'

describe('cancel', function () {
  it('should reject missing arguments', async function (this: TestContext) {
    await assert.rejects(async () => {
      this.boss = await helper.start(this.bossConfig)
      await this.boss.cancel(null as any, null as any)
    })
  })

  it('should cancel a pending job', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema, {}, { startAfter: 1 })

    await this.boss.cancel(this.schema, jobId!)

    const job = await this.boss.getJobById(this.schema, jobId!)

    assert(job && job.state === 'cancelled')
  })

  it('should not cancel a completed job', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig)

    await this.boss.send(this.schema)

    const [job] = await this.boss.fetch(this.schema)

    const completeResult = await this.boss.complete(this.schema, job.id)

    assert.strictEqual(completeResult.affected, 1)

    const cancelResult = await this.boss.cancel(this.schema, job.id)

    assert.strictEqual(cancelResult.affected, 0)
  })

  it('should cancel a batch of jobs', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig)

    const jobs = await Promise.all([
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema)
    ])

    await this.boss.cancel(this.schema, jobs as string[])
  })

  it('should cancel a pending job with custom connection', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return (_db as any).pool.query(sql, values)
      }
    }

    const jobId = await this.boss.send(this.schema, {}, { startAfter: 1 })

    await this.boss.cancel(this.schema, jobId!, { db })

    const job = await this.boss.getJobById(this.schema, jobId!)

    assert(job && job.state === 'cancelled')
    assert.strictEqual(called, true)
  })
})
