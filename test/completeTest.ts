import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { states } from '../src/index.ts'
import type { TestContext } from './hooks.ts'
import { type PgBoss } from '../src/index.ts'

describe('complete', function () {
  it('should reject missing id argument', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    assert.rejects(async () => {
      await this.boss.complete(this.schema)
    })
  })

  it('should complete a batch of jobs', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    const batchSize = 3

    await Promise.all([
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema)
    ])

    const { table } = (await this.boss.getQueue(this.schema))!

    const countJobs = (state: string) => helper.countJobs(this.schema, table, 'name = $1 AND state = $2', [this.schema, state])

    const jobs = await this.boss.fetch(this.schema, { batchSize })

    const activeCount = await countJobs(states.active)

    assert.strictEqual(activeCount, batchSize)

    const result = await this.boss.complete(this.schema, jobs.map(job => job.id))

    assert.strictEqual(batchSize, result.jobs.length)
  })

  it('should store job output in job.output from complete()', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    const jobId = await this.boss.send(this.schema)

    const [job] = await this.boss.fetch(this.schema)

    assert.strictEqual(jobId, job.id)

    const completionData = { msg: 'i am complete' }

    await this.boss.complete(this.schema, jobId, completionData)

    const jobWithMetadata = await this.boss.getJobById(this.schema, jobId)
    assert(jobWithMetadata)

    assert.strictEqual((jobWithMetadata as any).output.msg, completionData.msg)
  })

  it('should store job error in job.output from fail()', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    const jobId = await this.boss.send(this.schema)

    const [job] = await this.boss.fetch(this.schema)

    assert.strictEqual(jobId, job.id)

    const completionError = new Error('i am complete')

    await this.boss.fail(this.schema, jobId, completionError)

    const jobWithMetadata = await this.boss.getJobById(this.schema, jobId)
    assert(jobWithMetadata)

    assert.strictEqual((jobWithMetadata as any).output.message, completionError.message)
  })

  it('should complete a batch of jobs with custom connection', async function (this: TestContext) {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    const batchSize = 3

    await Promise.all([
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema)
    ])

    const { table } = (await this.boss.getQueue(this.schema))!

    const countJobs = (state: string) => helper.countJobs(this.schema, table, 'name = $1 AND state = $2', [this.schema, state])

    const jobs = await this.boss.fetch(this.schema, { batchSize })

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

    const result = await this.boss.complete(this.schema, jobs.map(job => job.id), undefined, { db })

    assert.strictEqual(batchSize, result.jobs.length)
    assert.strictEqual(called, true)
  })
})
