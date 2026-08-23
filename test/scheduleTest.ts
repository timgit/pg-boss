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

  it('a stored schedule with an unusable time zone does not stop other schedules from firing', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    // A row as an earlier release would have left it: schedule() accepted the zone because
    // cron-parser only rejects it once a date is computed. Written directly, since schedule()
    // now refuses it.
    const broken = `${ctx.schema}_broken`
    await ctx.boss.createQueue(broken)

    const db = await helper.getDb()
    await db.executeSql(
      `INSERT INTO ${ctx.schema}.schedule (name, key, cron, timezone, data, options)
       VALUES ($1, '', '* * * * *', 'Mars/Phobos', null, '{}'::jsonb)`,
      [broken]
    )

    // Poll rather than sleeping a fixed 4s: the chain is cron pass -> send-it insert -> send-it
    // worker -> fetch, and a fixed sleep is both slower in the common case and short on margin
    // when CI is loaded.
    const deadline = Date.now() + 20_000
    let job

    while (!job && Date.now() < deadline) {
      ;[job] = await ctx.boss.fetch(ctx.schema)

      if (!job) {
        await delay(250)
      }
    }

    // the healthy schedule must still fire — it did not before, because evaluating the broken row
    // threw straight out of the cron pass
    expect(job).toBeTruthy()
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

  it('schedule() rejects a time zone postgres-style cron parsing does not validate', async function () {
    const tk = makeTk(0)

    // cron-parser accepts any string as `tz` at parse time and only fails later, when a date is
    // actually computed. A typo therefore used to be stored happily and detonate on the cron pass.
    await expect(tk.schedule('q', '* * * * *', null, { tz: 'America/New_Yrok' })).rejects.toThrow(/time zone/i)
  })

  it('schedule() reports a bad cron expression as a cron error even when the time zone is also bad', async function () {
    const tk = makeTk(0)

    // The expression is validated before the zone, so the more specific error wins. This ordering
    // is load-bearing: reversed, a typo in both would be reported only as a time zone problem and
    // the expression would still be broken after the user fixed the zone.
    await expect(tk.schedule('q', 'not a cron', null, { tz: 'Mars/Phobos' })).rejects.toThrow(/Invalid characters/)

    // and a valid expression with a bad zone still reports the zone
    await expect(tk.schedule('q', '* * * * *', null, { tz: 'Mars/Phobos' })).rejects.toThrow(/time zone/i)
  })

  it('schedule() still accepts the time zone spellings that already worked', async function () {
    const tk = makeTk(0)

    for (const tz of ['UTC', 'utc', 'America/New_York', 'EST5EDT', '+05:30', 'Etc/GMT+3']) {
      await expect(tk.schedule('q', '* * * * *', null, { tz })).resolves.toBeUndefined()
    }

    // omitting tz entirely keeps defaulting to UTC
    await expect(tk.schedule('q', '* * * * *')).resolves.toBeUndefined()
  })

  it('one unusable schedule row does not stop every other schedule from firing', async function () {
    const tk = makeTk(0)
    ;(tk as any).stopped = false

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    // A row that predates validation (or was written straight to the table) carries a time zone
    // that throws once prev() computes a date. It must be skipped, not allowed to abort the pass:
    // cron() filtered every schedule through one shouldSendIt() call, so this single row silently
    // stopped scheduling for every queue in the whole deployment, on every pass, forever.
    ;(tk as any).getSchedules = async () => ([
      { name: 'broken', key: '', data: null, options: {}, cron: '* * * * *', timezone: 'Mars/Phobos' },
      { name: 'healthy', key: '', data: null, options: {}, cron: '* * * * *', timezone: 'UTC' }
    ])

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))
    tk.on('error', () => {}) // must not be needed, but don't crash the run if it is

    await tk.cron()

    expect(inserted.length).toBe(1)
    expect(inserted[0].singletonKey).toBe('healthy__')

    // and the operator has to be told which schedule is broken, or it stays invisible
    expect(warnings.length).toBe(1)
    expect(warnings[0].message).toMatch(/broken/)
  })

  it('an unusable schedule row warns once, not on every pass', async function () {
    const tk = makeTk(0)
    ;(tk as any).stopped = false
    ;(tk as any).manager = { insert: async () => {} }
    ;(tk as any).getSchedules = async () => ([
      { name: 'broken', key: '', data: null, options: {}, cron: '* * * * *', timezone: 'Mars/Phobos' }
    ])

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    // Every other warning type describes something that clears itself — skew converges, a backlog
    // drains, a slow query is a one-off. A bad schedule row sits there until a human edits it, so
    // warning per pass would persist a row every cronMonitorIntervalSeconds forever, and
    // warningRetentionDays has no default to bound it.
    for (let i = 0; i < 5; i++) {
      await tk.cron()
    }

    expect(warnings.length).toBe(1)
  })

  it('a repaired schedule row warns again if it breaks a second time', async function () {
    const tk = makeTk(0)
    ;(tk as any).stopped = false
    ;(tk as any).manager = { insert: async () => {} }

    let timezone = 'Mars/Phobos'
    ;(tk as any).getSchedules = async () => ([
      { name: 'broken', key: '', data: null, options: {}, cron: '* * * * *', timezone }
    ])

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()
    await tk.cron()
    expect(warnings.length).toBe(1)

    // fixed: the row drops out of the warned set, so the suppression must not outlive it
    timezone = 'UTC'
    await tk.cron()
    expect(warnings.length).toBe(1)

    // broken again — a fresh occurrence the operator has not seen
    timezone = 'Mars/Phobos'
    await tk.cron()
    expect(warnings.length).toBe(2)
  })

  it('editing an unusable schedule row into a different unusable state warns again', async function () {
    const tk = makeTk(0)
    ;(tk as any).stopped = false
    ;(tk as any).manager = { insert: async () => {} }

    let timezone = 'Mars/Phobos'
    ;(tk as any).getSchedules = async () => ([
      { name: 'broken', key: '', data: null, options: {}, cron: '* * * * *', timezone }
    ])

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()

    // suppression keys on the whole row, so a failed repair attempt is reported rather than
    // swallowed as "already warned about that queue"
    timezone = 'America/New_Yrok'
    await tk.cron()

    expect(warnings.length).toBe(2)
    expect(warnings[1].data.timezone).toBe('America/New_Yrok')
  })

  it('start() re-surfaces a schedule row nobody has fixed', async function () {
    const tk = makeTk(0)
    ;(tk as any).stopped = false
    ;(tk as any).manager = { insert: async () => {} }
    ;(tk as any).getSchedules = async () => ([
      { name: 'broken', key: '', data: null, options: {}, cron: '* * * * *', timezone: 'Mars/Phobos' }
    ])

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()
    expect(warnings.length).toBe(1)

    // The suppression is per-instance and deliberately does not survive a restart: a redeploy is
    // exactly when an operator is looking, and an unfixed row should say so again.
    ;(tk as any).warnedSchedules.clear()

    await tk.cron()

    expect(warnings.length).toBe(2)
  })
})
