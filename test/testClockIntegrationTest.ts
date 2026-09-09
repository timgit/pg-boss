import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss, TestClock } from '../src/index.ts'
import * as plans from '../src/plans.ts'
import { delay } from '../src/tools.ts'

// A fixed epoch keeps the tests independent of when they run.
const MINUTE = 60_000
const T0 = Date.parse('2026-01-01T12:00:30Z')

async function countJobs (boss: PgBoss, name: string): Promise<number> {
  const { rows } = await boss.getDb().executeSql(`SELECT count(*)::int AS n FROM ${ctx.schema}.job WHERE name = $1`, [name])
  return rows[0].n
}

async function dbTime (boss: PgBoss): Promise<number> {
  const { rows } = await boss.getDb().executeSql(plans.getTime(ctx.schema))
  return Number(rows[0].time)
}

// Real-time wait for I/O a tick started; tick itself never waits on I/O.
async function until (predicate: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('until: condition not met')
    await delay(10)
  }
}

describe('TestClock', function () {
  it('the database clock follows setTime and tick', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    expect(await dbTime(ctx.boss)).toBe(T0)

    await clock.tick(1500)
    expect(await dbTime(ctx.boss)).toBe(T0 + 1500)

    await clock.setTime(T0 - MINUTE)
    expect(await dbTime(ctx.boss)).toBe(T0 - MINUTE)
  })

  it('a debounced burst yields three jobs across a slot boundary and two within one', async function () {
    const boundary = T0 + 30_000
    const clock = new TestClock(boundary - 100)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })
    const queue = ctx.schema

    await ctx.boss.sendDebounced(queue, null, null, 60)
    await clock.tick(200)
    await ctx.boss.sendDebounced(queue, null, null, 60)
    await ctx.boss.sendDebounced(queue, null, null, 60)

    expect(await countJobs(ctx.boss, queue)).toBe(3)

    const mid = `${queue}_mid`
    await ctx.boss.createQueue(mid)
    await clock.setTime(boundary + 30_000)

    for (let i = 0; i < 3; i++) {
      await ctx.boss.sendDebounced(mid, null, null, 60)
    }

    expect(await countJobs(ctx.boss, mid)).toBe(2)
  })

  it('a deferred job becomes fetchable when the clock reaches startAfter', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await ctx.boss.send(ctx.schema, null, { startAfter: 60 })

    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)

    await clock.tick(MINUTE - 1)
    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)

    await clock.tick(1)
    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(1)
  })

  it('a handler is failed with the expiration message once the clock passes expireInSeconds', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const id = await ctx.boss.send(ctx.schema, null, { expireInSeconds: 5, retryLimit: 0 })
    assertTruthy(id)

    await ctx.boss.work(ctx.schema, () => new Promise(() => {}))
    await spy.waitForJobWithId(id, 'active')

    await clock.tick(5000)

    const job = await spy.waitForJobWithId(id, 'failed')
    expect((job.output as { message: string }).message).toBe('handler execution exceeded 5s')
  })

  it('a failed job is retried only after retryDelay has elapsed on the clock', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await ctx.boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 30 })

    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)
    await ctx.boss.fail(ctx.schema, job.id)

    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(0)

    await clock.tick(30_000)

    const [retried] = await ctx.boss.fetch(ctx.schema)
    expect(retried?.id).toBe(job.id)
  })

  it('a cron schedule enqueues after ticking through its next occurrence', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: true, cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1 })

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    expect(await countJobs(ctx.boss, ctx.schema)).toBe(0)

    await clock.tick(MINUTE)
    await until(async () => (await countJobs(ctx.boss!, '__pgboss__send-it')) > 0)

    await clock.tick(1000)
    await until(async () => (await countJobs(ctx.boss!, ctx.schema)) > 0)

    expect(await countJobs(ctx.boss, ctx.schema)).toBeGreaterThanOrEqual(1)
  })

  it('schema drift is clean while attached and after the clock is released', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    expect((await ctx.boss.detectSchemaDrift()).ok).toBe(true)

    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    expect((await ctx.boss.detectSchemaDrift()).ok).toBe(true)
  })

  it('one clock drives two instances on one schema and releases the schema with the last', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })
    const second = await helper.start({ ...ctx.bossConfig, clock, noDefault: true })

    await clock.setTime(T0 + MINUTE)
    expect(await dbTime(ctx.boss)).toBe(T0 + MINUTE)
    expect(await dbTime(second)).toBe(T0 + MINUTE)

    await second.stop({ graceful: false })
    expect(await dbTime(ctx.boss)).toBe(T0 + MINUTE)

    await ctx.boss.stop({ graceful: false })

    const db = await helper.getDb()
    try {
      const { rows } = await db.executeSql(plans.getTime(ctx.schema))
      expect(Math.abs(Number(rows[0].time) - Date.now())).toBeLessThan(60_000)
    } finally {
      await db.close()
    }
  })
})
