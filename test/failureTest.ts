import { delay } from '../src/tools.ts'
import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('failure', function () {
  it('should reject missing id argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.fail()
    }).rejects.toThrow()
  })

  it('should fail a job when requested', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    await ctx.boss.fail(ctx.schema, job.id)
  })

  it('should fail a batch of jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 3 })

    const result = await ctx.boss.fail(ctx.schema, jobs.map(job => job.id))

    expect(result.jobs.length).toBe(3)
  })

  it('should fail a batch of jobs with a data arg', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const message = 'some error'

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 3 })

    await ctx.boss.fail(ctx.schema, jobs.map(job => job.id), new Error(message))

    const results = await Promise.all(jobs.map(job => ctx.boss!.getJobById(ctx.schema, job.id)))

    // @ts-ignore
    expect(results.every(i => i!.output.message === message)).toBeTruthy()
  })

  it('should preserve nested objects within a payload that is an instance of Error', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const failPayload = new Error('Something went wrong')
    // @ts-ignore
    failPayload.some = { deeply: { nested: { reason: 'nuna' } } }

    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId, failPayload)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job?.output).toBeTruthy()

    // @ts-ignore
    expect(job.output.some.deeply.nested.reason).toBe(failPayload.some.deeply.nested.reason)
  })

  it('failure via Promise reject() should pass string wrapped in value prop', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const failPayload = 'mah error'

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, () => Promise.reject(failPayload))

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { value: string }).value).toBe(failPayload)
  })

  it('failure via Promise reject() should pass object payload', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = ctx.boss.getSpy(ctx.schema)
    const errorResponse = new Error('custom error')
    // @ts-ignore
    errorResponse.something = something

    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, () => Promise.reject(errorResponse))

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { something: string }).something).toBe(something)
  })

  it('failure with Error object should be saved in the job', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const message = 'a real error!'

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, async () => { throw new Error(message) })

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { message: string }).message.includes(message)).toBeTruthy()
  })

  it('should fail a job with custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    let called = false
    const _db = await helper.getDb()
    const db = {
      // @ts-ignore
      async executeSql (sql, values) {
        called = true
        // @ts-ignore
        return _db.pool.query(sql, values)
      }
    }

    await ctx.boss.fail(ctx.schema, job.id, null, { db })

    expect(called).toBe(true)
  })

  it('failure with circular payload should be safely serialized', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    const message = 'mhmm'

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      const err = { message }
      // @ts-ignore
      err.myself = err
      throw err
    })

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { message: string }).message).toBe(message)
  })

  it('dead letter queues are working', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0 })

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId)

    const [job] = await ctx.boss.fetch<typeof ctx.schema, { key: string }>(deadLetter)

    expect(job.data.key).toBe(ctx.schema)
  })

  it('should fail active jobs in a worker during shutdown', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 1 })

    await ctx.boss.work(ctx.schema, async () => await delay(4000))

    await delay(500)

    await ctx.boss.stop({ timeout: 2000 })

    await ctx.boss.start()

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job?.id).toBe(jobId)
  })
})
