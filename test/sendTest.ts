import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('send', function () {
  it('should fail with no arguments', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await testContext.boss.send()
    }).rejects.toThrow()
  })

  it('should fail with a function for data', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await testContext.boss.send('job', () => true)
    }).rejects.toThrow()
  })

  it('should fail with a function for options', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await testContext.boss.send('job', 'data', () => true)
    }).rejects.toThrow()
  })

  it('should accept single string argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)
  })

  it('should accept job object argument with only name', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send({ name: testContext.schema })
  })

  it('should accept job object with name and data only', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const message = 'hi'

    await testContext.boss.send({ name: testContext.schema, data: { message } })

    const [job] = await testContext.boss.fetch<{ message: string }>(testContext.schema)

    expect(job.data.message).toBe(message)
  })

  it('should accept job object with name and options only', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const options = { retryLimit: 1 }

    await testContext.boss.send({ name: testContext.schema, options })

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job.data).toBe(null)
  })

  it('should accept job object with name and custom connection', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    let called = false
    const db = await helper.getDb()
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          called = true
          // @ts-ignore
          return db.pool.query(sql, values)
        }
      },
      someCrazyOption: 'whatever'
    }

    await testContext.boss.send({ name: testContext.schema, options })

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job).not.toBe(null)
    expect(job.data).toBe(null)
    expect(called).toBe(true)
  })

  it('should not create job if transaction fails', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const { schema } = testContext.bossConfig

    const db = await helper.getDb()
    const client = (db as any).pool
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.test (label VARCHAR(50))`)

    const throwError = () => { throw new Error('Error') }

    try {
      await client.query('BEGIN')
      const options = {
        db: {
          async executeSql (sql: string, values: any[]) {
            return client.query(sql, values)
          }
        },
        someCrazyOption: 'whatever'
      }
      const queryText = `INSERT INTO ${schema}.test(label) VALUES('Test')`
      await client.query(queryText)

      await testContext.boss.send({ name: testContext.schema, options })

      throwError()
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
    }

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job).toBeFalsy()
  })

  it('should create job with all properties', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const deadLetter = `${testContext.schema}_dlq`
    await testContext.boss.createQueue(deadLetter)
    await testContext.boss.updateQueue(testContext.schema, { deadLetter })

    const options = {
      priority: 1,
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 3,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      deleteAfterSeconds: 60,
      singletonKey: '123',
      retentionSeconds: 10
    }

    const keepUntil = new Date(new Date(options.startAfter).getTime() + (options.retentionSeconds * 1000)).toISOString()

    const id = await testContext.boss.send(testContext.schema, {}, options)

    const job = await testContext.boss.getJobById(testContext.schema, id!)
    expect(job).toBeTruthy()

    expect(job!.priority).toBe(options.priority)
    expect(job!.retryLimit).toBe(options.retryLimit)
    expect(job!.retryDelay).toBe(options.retryDelay)
    expect(job!.retryBackoff).toBe(options.retryBackoff)
    expect(job!.retryDelayMax).toBe(options.retryDelayMax)
    expect(new Date(job!.startAfter).toISOString()).toBe(options.startAfter)
    expect(job!.expireInSeconds).toBe(options.expireInSeconds)
    expect(job!.deleteAfterSeconds).toBe(options.deleteAfterSeconds)
    expect(job!.singletonKey).toBe(options.singletonKey)
    expect(new Date(job!.keepUntil).toISOString()).toBe(keepUntil)
  })
})
