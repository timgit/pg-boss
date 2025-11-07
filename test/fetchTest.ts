import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { type PgBoss } from '../src/index.ts'

describe('fetch', function () {
  it('should reject missing queue argument', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    assert.rejects(async () => {
      await this.boss.fetch()
    })
  })

  it('should fetch a job by name manually', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    await this.boss.send(this.schema)
    const [job] = await this.boss.fetch(this.schema)
    assert(this.schema === job.name)
    // Metadata should only be included when specifically requested
    assert(job.startedOn === undefined)
  })

  it('should get a batch of jobs as an array', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss
    const batchSize = 4

    await Promise.all([
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema)
    ])

    const jobs = await this.boss.fetch(this.schema, { batchSize })

    assert(jobs.length === batchSize)
    // Metadata should only be included when specifically requested
    assert(jobs[0].startedOn === undefined)
  })

  it('should fetch all metadata for a single job when requested', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    await this.boss.send(this.schema)
    const [job] = await this.boss.fetch(this.schema, { includeMetadata: true })

    assert(this.schema === job.name)
    assert(job.state === 'active')

    assert(job.priority !== undefined)
    assert(job.policy !== undefined)
    assert(job.retryLimit !== undefined)
    assert(job.retryCount !== undefined)
    assert(job.retryDelay !== undefined)
    assert(job.retryBackoff === false)
    assert(job.retryDelayMax !== undefined)
    assert(job.startAfter !== undefined)
    assert(job.startedOn !== undefined)
    assert(job.singletonKey !== undefined)
    assert(job.singletonOn !== undefined)
    assert(job.expireInSeconds !== undefined)
    assert(job.deleteAfterSeconds !== undefined)
    assert(job.createdOn !== undefined)
    assert(job.completedOn !== undefined)
    assert(job.keepUntil !== undefined)
    assert(job.deadLetter !== undefined)
  })

  it('should fetch all metadata for a batch of jobs when requested', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss
    const batchSize = 4

    await Promise.all([
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema),
      this.boss.send(this.schema)
    ])

    const jobs = await this.boss.fetch(this.schema, { batchSize, includeMetadata: true })
    assert(jobs.length === batchSize)

    for (const job of jobs) {
      assert(this.schema === job.name)
      assert(job.state === 'active')
      assert(job.priority !== undefined)
      assert(job.policy !== undefined)
      assert(job.retryLimit !== undefined)
      assert(job.retryCount !== undefined)
      assert(job.retryDelay !== undefined)
      assert(job.retryBackoff === false)
      assert(job.retryDelayMax !== undefined)
      assert(job.startAfter !== undefined)
      assert(job.startedOn !== undefined)
      assert(job.singletonKey === null)
      assert(job.singletonOn === null)
      assert(job.expireInSeconds !== undefined)
      assert(job.createdOn !== undefined)
      assert(job.completedOn === null)
      assert(job.keepUntil !== undefined)
    }
  })

  it('should fetch all metadata for a single job with exponential backoff when requested', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    await this.boss.send(this.schema, null, { retryLimit: 1, retryDelay: 1, retryBackoff: true, retryDelayMax: 10 })
    const [job] = await this.boss.fetch(this.schema, { includeMetadata: true })

    assert.strictEqual(job.name, this.schema)
    assert.strictEqual(job.priority, 0)
    assert.strictEqual(job.state, 'active')
    assert(job.policy !== undefined)
    assert.strictEqual(job.retryLimit, 1)
    assert.strictEqual(job.retryCount, 0)
    assert.strictEqual(job.retryDelay, 1)
    assert.strictEqual(job.retryBackoff, true)
    assert.strictEqual(job.retryDelayMax, 10)
    assert(job.startAfter !== undefined)
    assert(job.startedOn !== undefined)
    assert.strictEqual(job.singletonKey, null)
    assert.strictEqual(job.singletonOn, null)
    assert(job.expireInSeconds !== undefined)
    assert(job.createdOn !== undefined)
    assert.strictEqual(job.completedOn, null)
    assert(job.keepUntil !== undefined)
  })

  it('should fetch all metadata for a batch of jobs with exponential backoff when requested', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss
    const options = { retryDelay: 1, retryBackoff: true, retryDelayMax: 10 }
    const batchSize = 4

    await Promise.all([
      this.boss.send(this.schema, null, options),
      this.boss.send(this.schema, null, options),
      this.boss.send(this.schema, null, options),
      this.boss.send(this.schema, null, options)
    ])

    const jobs = await this.boss.fetch(this.schema, { batchSize, includeMetadata: true })
    assert(jobs.length === batchSize)

    for (const job of jobs) {
      assert(this.schema === job.name)
      assert(job.priority === 0)
      assert(job.state === 'active')
      assert(job.policy !== undefined)
      assert(job.retryLimit !== undefined)
      assert(job.retryCount === 0)
      assert(job.retryDelay === 1)
      assert(job.retryBackoff === true)
      assert(job.retryDelayMax === 10)
      assert(job.startAfter !== undefined)
      assert(job.startedOn !== undefined)
      assert(job.singletonKey !== undefined)
      assert(job.singletonOn !== undefined)
      assert(job.expireInSeconds !== undefined)
      assert(job.deleteAfterSeconds !== undefined)
      assert(job.createdOn !== undefined)
      assert(job.completedOn !== undefined)
      assert(job.keepUntil !== undefined)
      assert(job.deadLetter !== undefined)
    }
  })

  it('should fetch a job with custom connection', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    let calledCounter = 0
    const db = await helper.getDb()
    const options = {
      db: {
        async executeSql (sql, values) {
          calledCounter++
          return db.pool.query(sql, values)
        }
      }
    }

    await this.boss.send(this.schema, {}, options)
    const [job] = await this.boss.fetch(this.schema, { ...options, batchSize: 10 })
    assert(this.schema === job.name)
    assert(job.startedOn === undefined)
    assert.strictEqual(calledCounter, 2)
  })

  it('should allow fetching jobs that have a start_after in the future', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    await this.boss.send(this.schema, { startAfter: new Date(Date.now() + 1000) })
    const db = await helper.getDb()
    const sqlStatements = []
    const options = {
      db: {
        async executeSql (sql, values) {
          sqlStatements.push(sql)
          return db.pool.query(sql, values)
        }
      }
    }

    const jobs = await this.boss.fetch(this.schema, { ...options, ignoreStartAfter: true })
    assert(jobs.length === 1)
    assert(sqlStatements.length === 1)
    assert(!sqlStatements[0].includes('start_after < now()'))
  })
})
