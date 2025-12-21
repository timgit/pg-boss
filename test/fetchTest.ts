import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('fetch', function () {
  it('should reject missing queue argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.fetch()
    })
  })

  it('should fetch a job by name manually', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)
    const [job] = await testContext.boss.fetch(testContext.schema)
    assert(testContext.schema === job.name)
  })

  it('should get a batch of jobs as an array', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const batchSize = 4

    await Promise.all([
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema)
    ])

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize })

    assert(jobs.length === batchSize)
  })

  it('should fetch all metadata for a single job when requested', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)
    const [job] = await testContext.boss.fetch(testContext.schema, { includeMetadata: true })

    assert(testContext.schema === job.name)
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
    testContext.boss = await helper.start(testContext.bossConfig)
    const batchSize = 4

    await Promise.all([
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema),
      testContext.boss.send(testContext.schema)
    ])

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize, includeMetadata: true })
    assert(jobs.length === batchSize)

    for (const job of jobs) {
      assert(testContext.schema === job.name)
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
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema, null, { retryLimit: 1, retryDelay: 1, retryBackoff: true, retryDelayMax: 10 })
    const [job] = await testContext.boss.fetch(testContext.schema, { includeMetadata: true })

    assert.strictEqual(job.name, testContext.schema)
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
    testContext.boss = await helper.start(testContext.bossConfig)
    const options = { retryDelay: 1, retryBackoff: true, retryDelayMax: 10 }
    const batchSize = 4

    await Promise.all([
      testContext.boss.send(testContext.schema, null, options),
      testContext.boss.send(testContext.schema, null, options),
      testContext.boss.send(testContext.schema, null, options),
      testContext.boss.send(testContext.schema, null, options)
    ])

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize, includeMetadata: true })
    assert(jobs.length === batchSize)

    for (const job of jobs) {
      assert(testContext.schema === job.name)
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
    testContext.boss = await helper.start(testContext.bossConfig)

    let calledCounter = 0
    const db = await helper.getDb()
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          calledCounter++
          // @ts-ignore
          return db.pool.query(sql, values)
        }
      }
    }

    await testContext.boss.send(testContext.schema, {}, options)
    const [job] = await testContext.boss.fetch(testContext.schema, { ...options, batchSize: 10 })
    assert(testContext.schema === job.name)
    assert.strictEqual(calledCounter, 2)
  })

  it('should allow fetching jobs that have a start_after in the future', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema, { startAfter: new Date(Date.now() + 1000) })
    const db = await helper.getDb()
    const sqlStatements : string[] = []
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          sqlStatements.push(sql)
          // @ts-ignore
          return db.pool.query(sql, values)
        }
      }
    }

    const jobs = await testContext.boss.fetch(testContext.schema, { ...options, ignoreStartAfter: true })
    assert(jobs.length === 1)
    assert(sqlStatements.length === 1)
    assert(!sqlStatements[0].includes('start_after < now()'))
  })
})
