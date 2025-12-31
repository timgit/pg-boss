import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('send', function () {
  it('should fail with no arguments', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.send()
    }).rejects.toThrow()
  })

  it('should fail with a function for data', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.send('job', () => true)
    }).rejects.toThrow()
  })

  it('should fail with a function for options', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.send('job', 'data', () => true)
    }).rejects.toThrow()
  })

  it('should accept single string argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
  })

  it('should accept job object argument with only name', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send({ name: ctx.schema })
  })

  it('should accept job object with name and data only', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const message = 'hi'

    await ctx.boss.send({ name: ctx.schema, data: { message } })

    const [job] = await ctx.boss.fetch<{ message: string }>(ctx.schema)

    expect(job.data.message).toBe(message)
  })

  it('should accept job object with name and options only', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const options = { retryLimit: 1 }

    await ctx.boss.send({ name: ctx.schema, options })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.data).toBe(null)
  })

  it('should accept job object with name and custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

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

    await ctx.boss.send({ name: ctx.schema, options })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).not.toBe(null)
    expect(job.data).toBe(null)
    expect(called).toBe(true)
  })

  it('should not create job if transaction fails', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const { schema } = ctx.bossConfig

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

      await ctx.boss.send({ name: ctx.schema, options })

      throwError()
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
    }

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()
  })

  it('should create job with all properties', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.updateQueue(ctx.schema, { deadLetter })

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

    const id = await ctx.boss.send(ctx.schema, {}, options)

    assertTruthy(id)
    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)

    expect(job.priority).toBe(options.priority)
    expect(job.retryLimit).toBe(options.retryLimit)
    expect(job.retryDelay).toBe(options.retryDelay)
    expect(job.retryBackoff).toBe(options.retryBackoff)
    expect(job.retryDelayMax).toBe(options.retryDelayMax)
    expect(new Date(job.startAfter).toISOString()).toBe(options.startAfter)
    expect(job.expireInSeconds).toBe(options.expireInSeconds)
    expect(job.deleteAfterSeconds).toBe(options.deleteAfterSeconds)
    expect(job.singletonKey).toBe(options.singletonKey)
    expect(new Date(job.keepUntil).toISOString()).toBe(keepUntil)
  })
})
