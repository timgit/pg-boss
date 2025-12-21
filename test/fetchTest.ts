import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('fetch', function () {
  it('should reject missing queue argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await testContext.boss.fetch()
    }).rejects.toThrow()
  })

  it('should fetch a job by name manually', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)
    const [job] = await testContext.boss.fetch(testContext.schema)
    expect(job.name).toBe(testContext.schema)
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

    expect(jobs.length === batchSize).toBeTruthy()
  })

  it('should fetch all metadata for a single job when requested', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)
    const [job] = await testContext.boss.fetch(testContext.schema, { includeMetadata: true })

    expect(job.name).toBe(testContext.schema)
    expect(job.state).toBe('active')

    expect(job.priority !== undefined).toBeTruthy()
    expect(job.policy !== undefined).toBeTruthy()
    expect(job.retryLimit !== undefined).toBeTruthy()
    expect(job.retryCount !== undefined).toBeTruthy()
    expect(job.retryDelay !== undefined).toBeTruthy()
    expect(job.retryBackoff).toBe(false)
    expect(job.retryDelayMax !== undefined).toBeTruthy()
    expect(job.startAfter !== undefined).toBeTruthy()
    expect(job.startedOn !== undefined).toBeTruthy()
    expect(job.singletonKey !== undefined).toBeTruthy()
    expect(job.singletonOn !== undefined).toBeTruthy()
    expect(job.expireInSeconds !== undefined).toBeTruthy()
    expect(job.deleteAfterSeconds !== undefined).toBeTruthy()
    expect(job.createdOn !== undefined).toBeTruthy()
    expect(job.completedOn !== undefined).toBeTruthy()
    expect(job.keepUntil !== undefined).toBeTruthy()
    expect(job.deadLetter !== undefined).toBeTruthy()
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
    expect(jobs.length === batchSize).toBeTruthy()

    for (const job of jobs) {
      expect(job.name).toBe(testContext.schema)
      expect(job.state).toBe('active')
      expect(job.priority !== undefined).toBeTruthy()
      expect(job.policy !== undefined).toBeTruthy()
      expect(job.retryLimit !== undefined).toBeTruthy()
      expect(job.retryCount !== undefined).toBeTruthy()
      expect(job.retryDelay !== undefined).toBeTruthy()
      expect(job.retryBackoff).toBe(false)
      expect(job.retryDelayMax !== undefined).toBeTruthy()
      expect(job.startAfter !== undefined).toBeTruthy()
      expect(job.startedOn !== undefined).toBeTruthy()
      expect(job.singletonKey).toBe(null)
      expect(job.singletonOn).toBe(null)
      expect(job.expireInSeconds !== undefined).toBeTruthy()
      expect(job.createdOn !== undefined).toBeTruthy()
      expect(job.completedOn).toBe(null)
      expect(job.keepUntil !== undefined).toBeTruthy()
    }
  })

  it('should fetch all metadata for a single job with exponential backoff when requested', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema, null, { retryLimit: 1, retryDelay: 1, retryBackoff: true, retryDelayMax: 10 })
    const [job] = await testContext.boss.fetch(testContext.schema, { includeMetadata: true })

    expect(job.name).toBe(testContext.schema)
    expect(job.priority).toBe(0)
    expect(job.state).toBe('active')
    expect(job.policy !== undefined).toBeTruthy()
    expect(job.retryLimit).toBe(1)
    expect(job.retryCount).toBe(0)
    expect(job.retryDelay).toBe(1)
    expect(job.retryBackoff).toBe(true)
    expect(job.retryDelayMax).toBe(10)
    expect(job.startAfter !== undefined).toBeTruthy()
    expect(job.startedOn !== undefined).toBeTruthy()
    expect(job.singletonKey).toBe(null)
    expect(job.singletonOn).toBe(null)
    expect(job.expireInSeconds !== undefined).toBeTruthy()
    expect(job.createdOn !== undefined).toBeTruthy()
    expect(job.completedOn).toBe(null)
    expect(job.keepUntil !== undefined).toBeTruthy()
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
    expect(jobs.length === batchSize).toBeTruthy()

    for (const job of jobs) {
      expect(job.name).toBe(testContext.schema)
      expect(job.priority).toBe(0)
      expect(job.state).toBe('active')
      expect(job.policy !== undefined).toBeTruthy()
      expect(job.retryLimit !== undefined).toBeTruthy()
      expect(job.retryCount).toBe(0)
      expect(job.retryDelay).toBe(1)
      expect(job.retryBackoff).toBe(true)
      expect(job.retryDelayMax).toBe(10)
      expect(job.startAfter !== undefined).toBeTruthy()
      expect(job.startedOn !== undefined).toBeTruthy()
      expect(job.singletonKey !== undefined).toBeTruthy()
      expect(job.singletonOn !== undefined).toBeTruthy()
      expect(job.expireInSeconds !== undefined).toBeTruthy()
      expect(job.deleteAfterSeconds !== undefined).toBeTruthy()
      expect(job.createdOn !== undefined).toBeTruthy()
      expect(job.completedOn !== undefined).toBeTruthy()
      expect(job.keepUntil !== undefined).toBeTruthy()
      expect(job.deadLetter !== undefined).toBeTruthy()
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
    expect(job.name).toBe(testContext.schema)
    expect(calledCounter).toBe(2)
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
    expect(jobs.length).toBe(1)
    expect(sqlStatements.length).toBe(1)
    expect(!sqlStatements[0].includes('start_after < now()')).toBeTruthy()
  })
})
