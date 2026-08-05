import { expect, vi } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import Manager from '../src/manager.ts'
import * as Attorney from '../src/attorney.ts'

// getQueues is the only query selecting q.table_name under this alias; a non-empty values
// array distinguishes the per-name lookup from the interval refresh.
const isGetQueues = (sql: string) => sql.includes('q.table_name as "table"')
const isLookup = (sql: string, values?: unknown[]) => isGetQueues(sql) && !!values?.length

// A Manager sharing the running boss's database but with its own empty cache and no timers,
// so cache state (manager.queues) is directly observable and refreshes run only when invoked.
function makeManager (): Manager {
  return new Manager(ctx.boss!.getDb(), Attorney.getConfig(ctx.bossConfig))
}

describe('queue cache', function () {
  it('createQueue write-through lets the next send hit the cache', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema)

    const db = ctx.boss.getDb()
    const real = db.executeSql.bind(db)
    let lookups = 0
    const spy = vi.spyOn(db, 'executeSql').mockImplementation(async (sql, values) => {
      if (isLookup(sql, values)) lookups++
      return real(sql, values)
    })

    const jobId = await ctx.boss.send(ctx.schema, {})

    expect(jobId).toBeTruthy()
    expect(lookups).toBe(0)

    spy.mockRestore()
  })

  it('createQueue on an existing queue caches the surviving row, not the request', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const manager = makeManager()
    await manager.createQueue(ctx.schema, { retryLimit: 3 })
    await manager.createQueue(ctx.schema, { retryLimit: 9 })

    expect(manager.queues![ctx.schema].retryLimit).toBe(3)
    expect((await manager.getQueueCache(ctx.schema)).retryLimit).toBe(3)
  })

  it('a single wrong-empty lookup does not fail send', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema)

    const manager = makeManager()
    const db = ctx.boss.getDb()
    const real = db.executeSql.bind(db)
    let lookups = 0
    const spy = vi.spyOn(db, 'executeSql').mockImplementation(async (sql, values) => {
      if (isLookup(sql, values) && lookups++ === 0) return { rows: [] }
      return real(sql, values)
    })

    const jobId = await manager.send(ctx.schema, {})

    expect(jobId).toBeTruthy()
    expect(lookups).toBe(2)

    spy.mockRestore()
  })

  it('a genuinely missing queue still throws from send', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const db = ctx.boss.getDb()
    const real = db.executeSql.bind(db)
    let lookups = 0
    const spy = vi.spyOn(db, 'executeSql').mockImplementation(async (sql, values) => {
      if (isLookup(sql, values)) lookups++
      return real(sql, values)
    })

    const missing = `${ctx.schema}_missing`
    await expect(ctx.boss.send(missing, {})).rejects.toThrow(`Queue ${missing} does not exist`)
    expect(lookups).toBe(2)

    spy.mockRestore()
  })

  it('one empty refresh keeps the cache and a second consecutive one wipes it', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema)

    const manager = makeManager()
    await manager.onCacheQueues()
    expect(manager.queues![ctx.schema]).toBeTruthy()

    const db = ctx.boss.getDb()
    const real = db.executeSql.bind(db)
    const spy = vi.spyOn(db, 'executeSql').mockImplementation(async (sql, values) => {
      if (isGetQueues(sql) && !values?.length) return { rows: [] }
      return real(sql, values)
    })

    await manager.onCacheQueues()
    expect(manager.queues![ctx.schema]).toBeTruthy()

    await manager.onCacheQueues()
    expect(manager.queues![ctx.schema]).toBeUndefined()

    spy.mockRestore()

    await manager.onCacheQueues()
    expect(manager.queues![ctx.schema]).toBeTruthy()
  })

  it('updateQueue write-through refreshes the cache entry without a later lookup', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const manager = makeManager()
    await manager.createQueue(ctx.schema, { retryLimit: 1 })
    await manager.updateQueue(ctx.schema, { retryLimit: 5 })

    expect(manager.queues![ctx.schema].retryLimit).toBe(5)

    const db = ctx.boss.getDb()
    const real = db.executeSql.bind(db)
    let lookups = 0
    const spy = vi.spyOn(db, 'executeSql').mockImplementation(async (sql, values) => {
      if (isLookup(sql, values)) lookups++
      return real(sql, values)
    })

    expect((await manager.getQueueCache(ctx.schema)).retryLimit).toBe(5)
    expect(lookups).toBe(0)

    spy.mockRestore()
  })
})
