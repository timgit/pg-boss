import { delay } from '../src/tools.ts'
import { expect } from 'vitest'
import { DateTime } from 'luxon'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import Timekeeper from '../src/timekeeper.ts'
import { ctx } from './hooks.ts'

describe('schedule', function () {
  it('should send job based on every minute expression', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    await delay(4000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeTruthy()
  })

  it('should set job metadata correctly', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *', {}, { retryLimit: 42, singletonSeconds: 5 })

    await delay(4000)

    const [job] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true })

    expect(job).toBeTruthy()
    expect(job.retryLimit).toBe(42)
    expect(job.singletonOn).toBeTruthy()
  })

  it('should fail to schedule a queue that does not exist', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await expect(async () => {
      await ctx.boss!.schedule(ctx.schema, '* * * * *')
    }).rejects.toThrow()
  })

  it('should send job based on every minute expression after a restart', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({ ...ctx.bossConfig, cronWorkerIntervalSeconds: 1, schedule: true })

    await delay(4000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeTruthy()

    await ctx.boss.stop({ graceful: false })
  })

  it('should remove previously scheduled job', async function () {
    const config = {
      ...ctx.bossConfig,
      cronWorkerIntervalSeconds: 1
    }
    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.unschedule(ctx.schema)

    const scheduled = await ctx.boss.getSchedules()

    expect(scheduled.length).toBe(0)
  })

  it('should send job based on current minute in UTC', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    const nowUtc = DateTime.utc()

    const currentMinute = nowUtc.minute
    const currentHour = nowUtc.hour

    const nextUtc = nowUtc.plus({ minutes: 1 })

    const nextMinute = nextUtc.minute
    const nextHour = nextUtc.hour

    // using current and next minute because the clock is ticking
    const minute = currentMinute === nextMinute ? currentMinute : `${currentMinute},${nextMinute}`
    const hour = currentHour === nextHour ? currentHour : `${currentHour},${nextHour}`

    const cron = `${minute} ${hour} * * *`

    await ctx.boss.schedule(ctx.schema, cron)

    await delay(6000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeTruthy()
  })

  it('should send job based on current minute in a specified time zone', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    const tz = 'America/Los_Angeles'

    const nowLocal = DateTime.fromObject({}, { zone: tz })

    const currentMinute = nowLocal.minute
    const currentHour = nowLocal.hour

    const nextLocal = nowLocal.plus({ minutes: 1 })

    const nextMinute = nextLocal.minute
    const nextHour = nextLocal.hour

    // using current and next minute because the clock is ticking
    const minute = currentMinute === nextMinute ? currentMinute : `${currentMinute},${nextMinute}`
    const hour = currentHour === nextHour ? currentHour : `${currentHour},${nextHour}`

    const cron = `${minute} ${hour} * * *`

    await ctx.boss.schedule(ctx.schema, cron, null, { tz })

    await delay(6000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeTruthy()
  })

  it('should force a clock skew warning', async function () {
    const config = {
      ...ctx.bossConfig,
      schedule: true,
      __test__force_clock_skew_warning: true
    }

    // @ts-ignore
    ctx.boss = new PgBoss(config)

    let warningCount = 0

    ctx.boss.once('warning', (warning) => {
      expect(warning.message).toContain('Clock skew')
      warningCount++
    })

    await ctx.boss.start()

    expect(warningCount).toBe(1)
  })

  it('errors during clock skew monitoring should emit', async function () {
    const config = {
      ...ctx.bossConfig,
      clockMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock skew monitoring'
    }

    let errorCount = 0

    ctx.boss = new PgBoss(config)

    ctx.boss.on('error', error => {
      expect(error.message).toBe(config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await ctx.boss.start()

    await delay(2000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })

  it('errors during cron monitoring should emit', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_cron_monitoring_error: 'pg-boss mock error: cron monitoring'
    }

    let errorCount = 0

    ctx.boss = new PgBoss(config)

    ctx.boss.on('error', error => {
      expect(error.message).toBe(config.__test__force_cron_monitoring_error)
      errorCount++
    })

    await ctx.boss.start()

    await delay(2000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })

  it('clock monitoring error handling works', async function () {
    const config = {
      ...ctx.bossConfig,
      schedule: true,
      clockMonitorIntervalSeconds: 1,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock monitoring'
    }

    let errorCount = 0

    ctx.boss = new PgBoss(config)

    ctx.boss.on('error', (error) => {
      expect(error.message).toBe(config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await ctx.boss.start()

    await delay(4000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })

  it('should accept a unique key to have more than one schedule per queue', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })
    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'b' })

    const schedules = await ctx.boss.getSchedules()

    expect(schedules.length).toBe(2)
  })

  it('should send jobs per unique key on the same cron', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })
    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'b' })

    await delay(4000)

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })

    expect(jobs.length).toBe(2)
  })

  it('should update a schedule with a unique key', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'a' })

    const schedules = await ctx.boss.getSchedules()

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should update a schedule without a unique key', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(ctx.schema, '0 1 * * *')

    const schedules = await ctx.boss.getSchedules()

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should remove a schedule using a unique key', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'b' })

    let schedules = await ctx.boss.getSchedules()

    expect(schedules.length).toBe(2)

    await ctx.boss.unschedule(ctx.schema, 'a')

    schedules = await ctx.boss.getSchedules()

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should get schedules filtered by a queue name', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    const queue2 = ctx.bossConfig.schema + '2'

    await ctx.boss.createQueue(queue2)

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(queue2, '0 1 * * *')

    let schedules = await ctx.boss.getSchedules()
    expect(schedules.length).toBe(2)

    schedules = await ctx.boss.getSchedules(queue2)

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should get schedules filtered by a queue name and key', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    const key = 'a'
    const queue2 = ctx.bossConfig.schema + '2'

    await ctx.boss.createQueue(queue2)

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key })
    await ctx.boss.schedule(queue2, '0 2 * * *')

    let schedules = await ctx.boss.getSchedules()
    expect(schedules.length).toBe(3)

    schedules = await ctx.boss.getSchedules(ctx.schema, key)

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should get all schedules for a queue regardless of key when no key is given', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    const queue2 = ctx.bossConfig.schema + '2'

    await ctx.boss.createQueue(queue2)

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'b' })
    await ctx.boss.schedule(queue2, '0 2 * * *')

    const schedules = await ctx.boss.getSchedules(ctx.schema)

    expect(schedules.length).toBe(2)
    expect(schedules.every(s => s.name === ctx.schema)).toBeTruthy()
    expect(schedules.some(s => s.key === 'a')).toBeTruthy()
    expect(schedules.some(s => s.key === 'b')).toBeTruthy()
  })

  it('should get only the default-key schedule when key is explicitly empty', async function () {
    const config = {
      ...ctx.bossConfig
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'a' })

    const schedules = await ctx.boss.getSchedules(ctx.schema, '')

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('* * * * *')
  })
})

// Pure unit tests for the clock-domain logic — no database or running instance needed.
describe('timekeeper clock domain', function () {
  function makeTk (dbTimeOffsetMs: number, config: object = {}) {
    const db = {
      executeSql: async () => ({ rows: [{ time: String(Date.now() + dbTimeOffsetMs) }] })
    }
    // manager is unused by the methods under test
    return new Timekeeper(db as any, {} as any, { schema: 'test', ...config } as any)
  }

  it('cacheClockSkew keeps the last-known-good skew when the time query fails', async function () {
    const tk = makeTk(30_000) // db ~30s ahead (below the 60s warning threshold)
    await tk.cacheClockSkew()
    expect(tk.clockSkew).toBeGreaterThan(20_000)

    const good = tk.clockSkew

    tk.on('error', () => {}) // swallow the emitted error so it doesn't crash the process
    ;(tk.config as any).__test__force_clock_monitoring_error = 'boom'

    await tk.cacheClockSkew()

    // must NOT be clobbered back to 0
    expect(tk.clockSkew).toBe(good)
  })

  it('shouldSendIt fires within the window even when the database clock is far ahead', function () {
    const tk = makeTk(0)
    tk.clockSkew = 120_000 // db 2 minutes ahead of local

    // an every-minute cron: the previous boundary is always < 60s before database time regardless
    // of skew. Computing prev() from the local clock (the old bug) would push prevDiff past 60 and
    // silently kill scheduling.
    expect(tk.shouldSendIt('* * * * *', 'UTC')).toBe(true)
  })

  it('shouldSendIt does not fire when the previous occurrence is well outside the window', function () {
    const tk = makeTk(0)
    tk.clockSkew = 120_000

    // a yearly cron: the previous Jan-1 midnight is (except in the 60s after New Year UTC) far more
    // than 60s ago, so it must not fire — proving the window check isn't simply always-true.
    expect(tk.shouldSendIt('0 0 1 1 *', 'UTC')).toBe(false)
  })

  it('onSendIt emits an error when a forwarded cron send fails', async function () {
    const tk = makeTk(0)
    // a manager whose send always rejects
    ;(tk as any).manager = { send: async () => { throw new Error('forward failed') } }

    const errors: any[] = []
    tk.on('error', (e: any) => errors.push(e))

    // discarding allSettled results would drop this occurrence silently; it must emit instead
    await (tk as any).onSendIt([{ data: { name: 'q', data: null, options: {} } }])

    expect(errors.some(e => e.message === 'forward failed')).toBe(true)
  })
})
