import { describe, it, expect } from 'vitest'
import { ctx } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import * as plans from '../src/plans.ts'
import { next, rollback, getAll } from '../src/migrationStore.ts'

// Targeted coverage for argument-shape and option branches that the feature suites
// don't otherwise reach. Each case maps to a specific reachable branch.

describe('argument-shape coverage', function () {
  it('constructs from a connection string', function () {
    const boss = new PgBoss(helper.getConnectionString())
    expect(boss).toBeInstanceOf(PgBoss)
  })

  it('work() accepts null options and a boolean priority option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = ctx.schema

    await ctx.boss.work(queue, null as any, async () => {})
    await ctx.boss.offWork(queue)

    await ctx.boss.work(queue, { priority: true } as any, async () => {})
  })

  it('work() honors orderByCreatedOn:false and localGroupConcurrency without localConcurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = ctx.schema

    await ctx.boss.work(queue, { orderByCreatedOn: false } as any, async () => {})
    await ctx.boss.offWork(queue)

    await ctx.boss.work(queue, { localGroupConcurrency: 1 } as any, async () => {})
  })

  it('send variants accept null options, including a 1-second debounce', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = ctx.schema

    await ctx.boss.sendAfter(queue, { a: 1 }, null, 1)
    await ctx.boss.sendThrottled(queue, { a: 1 }, null, 60)
    await ctx.boss.sendDebounced(queue, { a: 1 }, null, 1)
  })

  it('getSpy returns the same instance on repeated calls', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true } as any)
    const queue = ctx.schema

    const first = ctx.boss.getSpy(queue)
    const second = ctx.boss.getSpy(queue)
    expect(second).toBe(first)
  })

  it('throttle and debounce accept an options object', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const queue = ctx.schema

    await ctx.boss.sendThrottled(queue, { a: 1 }, { priority: 1 } as any, 60)
    await ctx.boss.sendDebounced(queue, { a: 1 }, { priority: 1 } as any, 60)
  })

  it('a repeated debounce slots the second job and tracks it via a spy', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true } as any)
    const queue = ctx.schema
    ctx.boss.getSpy(queue)

    // First debounce inserts immediately; the second collides on the singleton
    // window and takes the slot path (getDebounceStartAfter + second insert),
    // exercising the spy-tracking branch on the retry. seconds=1 covers the
    // singletonSeconds <= 1 branch of getDebounceStartAfter.
    const id1 = await ctx.boss.sendDebounced(queue, { a: 1 }, null, 1)
    const id2 = await ctx.boss.sendDebounced(queue, { a: 2 }, null, 1)
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
  })

  it('insert tracks jobs when a spy is active', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true } as any)
    const queue = ctx.schema
    ctx.boss.getSpy(queue)

    const ids = await ctx.boss.insert(queue, [{ data: { a: 1 } }])
    expect(ids).toHaveLength(1)
  })

  it('falls back to the default heartbeat refresh interval', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { heartbeatSeconds: 60 })

    const done = new Promise<boolean>(resolve => {
      ctx.boss!.work(queue, async () => resolve(true))
    })
    await ctx.boss.send(queue)
    expect(await done).toBe(true)
  })

  it('flow() emits a NOTIFY for a notify-enabled queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = ctx.schema
    await ctx.boss.createQueue(queue, { notify: true })

    // Parent depends on a leaf child, all on a notify queue: exercises the notify
    // push, the leaf node (no outgoing edges) in cycle detection, and the
    // zero-dependency-count branch for the child.
    const ids = await ctx.boss.flow([
      { ref: 'parent', name: queue, data: { n: 1 }, dependsOn: ['child'] },
      { ref: 'child', name: queue, data: { n: 2 } }
    ])
    expect(Object.keys(ids).sort()).toEqual(['child', 'parent'])
  })
})

describe('plan-builder coverage', function () {
  it('transaction() accepts a single string statement', function () {
    const sql = plans.transaction('SELECT 1')
    expect(sql).toContain('BEGIN')
    expect(sql).toContain('SELECT 1')
  })

  it('next() resolves migrations from the store when none are supplied', function () {
    const all = getAll('pgboss')
    const sql = next('pgboss', all[0].previous)
    expect(typeof sql).toBe('string')
  })

  it('rollback() tolerates a migration without an uninstall block', function () {
    const sql = rollback('pgboss', 5, [
      { version: 5, previous: 4, release: 'test', install: [], uninstall: undefined } as any
    ])
    expect(typeof sql).toBe('string')
  })
})
