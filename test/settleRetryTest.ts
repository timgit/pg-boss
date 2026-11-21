import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import type { IDatabase } from '../src/types.ts'
import { ctx } from './hooks.ts'

// A poll interval no test waits out.
const pollingIntervalSeconds = 30

const isComplete = (sql: string) => sql.includes('SET completed_on')
const isFail = (sql: string) => sql.includes('deleted_jobs AS') && sql.includes('$2::uuid[]')

// Makes the next `times` statements that match fail as a connection the server closed would,
// before they reach the database. Counts every matching statement, failed or run.
function dropConnection (db: IDatabase, match: (sql: string) => boolean, times: number) {
  const executeSql = db.executeSql.bind(db)
  const state = { remaining: times, calls: 0 }

  db.executeSql = async (sql: string, values?: unknown[]) => {
    if (match(sql)) {
      state.calls++

      if (state.remaining > 0) {
        state.remaining--
        throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
      }
    }

    return await executeSql(sql, values)
  }

  return state
}

describe('settle retry', function () {
  it('should complete a job once its completion loses the connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const dropped = dropConnection(ctx.boss.getDb(), isComplete, 1)

    let handled = 0
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => { handled++ })

    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 1, failed: 0, timedOut: false })
    expect(handled).toBe(1)
    expect(dropped.calls).toBe(2)

    const job = await ctx.boss.getJobById(ctx.schema, id)
    expect(job?.state).toBe('completed')
  })

  it('should fail the job after the last retry of its completion', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const dropped = dropConnection(ctx.boss.getDb(), isComplete, 3)

    await ctx.boss.updateQueue(ctx.schema, { retryLimit: 1, retryDelay: 60 })
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {})

    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 1, failed: 1, timedOut: false })
    expect(dropped.calls).toBe(3)

    const job = await ctx.boss.getJobById(ctx.schema, id)
    expect(job?.state).toBe('retry')
    expect((job?.output as { message?: string })?.message).toBe('terminating connection due to administrator command')
  })

  it('should not retry a completion that failed for another reason', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const db = ctx.boss.getDb()
    const executeSql = db.executeSql.bind(db)
    let calls = 0

    db.executeSql = async (sql: string, values?: unknown[]) => {
      if (isComplete(sql)) {
        calls++
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      }

      return await executeSql(sql, values)
    }

    await ctx.boss.updateQueue(ctx.schema, { retryLimit: 1, retryDelay: 60 })
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {})

    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    await ctx.boss.drain()

    expect(calls).toBe(1)

    const job = await ctx.boss.getJobById(ctx.schema, id)
    expect(job?.state).toBe('retry')
  })

  it('should fail a job once its failure loses the connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const dropped = dropConnection(ctx.boss.getDb(), isFail, 1)

    await ctx.boss.updateQueue(ctx.schema, { retryLimit: 1, retryDelay: 60 })
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => { throw new Error('handler failed') })

    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 1, failed: 1, timedOut: false })
    expect(dropped.calls).toBe(2)

    // Left active, the job would wait out expireInSeconds before it ran again.
    const job = await ctx.boss.getJobById(ctx.schema, id)
    expect(job?.state).toBe('retry')
    expect((job?.output as { message?: string })?.message).toBe('handler failed')
  })

  it('should complete a perJobResults job once its completion loses the connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const dropped = dropConnection(ctx.boss.getDb(), isComplete, 1)

    await ctx.boss.updateQueue(ctx.schema, { retryLimit: 1, retryDelay: 60 })
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds, batchSize: 2, perJobResults: true }, async (jobs) =>
      jobs.map(job => ({ id: job.id, status: 'completed' as const, output: { done: true } })))

    const ids = await Promise.all([ctx.boss.send(ctx.schema), ctx.boss.send(ctx.schema)])

    await ctx.boss.drain()

    expect(dropped.calls).toBe(2)

    for (const id of ids) {
      assertTruthy(id)
      const job = await ctx.boss.getJobById(ctx.schema, id)
      expect(job?.state).toBe('completed')
    }
  })
})
