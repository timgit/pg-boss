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

// Pure unit tests for the clock-domain and occurrence logic, with no database or running
// instance needed. The fake database answers the four statements a cron pass makes (repair scan, claim,
// unsupported-kind scan, next-run write) so a pass can be driven a row at a time.
describe('timekeeper occurrences', function () {
  interface FakeState {
    repair?: any[]
    claim?: any[]
    unsupported?: any[]
    writes?: { name: string, key: string, nextRunAt: Date | null }[]
    released?: number
  }

  function makeDb (dbTimeOffsetMs: number, state: FakeState) {
    state.writes = state.writes || []

    return {
      executeSql: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('as time')) {
          return { rows: [{ time: String(Date.now() + dbTimeOffsetMs) }] }
        }

        if (sql.includes('WITH due AS')) {
          return { rows: state.claim || [] }
        }

        // one statement for the whole pass, so the rows arrive as a JSON payload
        if (sql.includes('SET next_run_at')) {
          for (const { name, key, nextRunAt } of JSON.parse(params[0] as string)) {
            state.writes!.push({ name, key, nextRunAt: new Date(nextRunAt) })
          }
          return { rows: [] }
        }

        if (sql.includes('SET cron_on = null')) {
          state.released = (state.released || 0) + 1
          return { rows: [] }
        }

        if (sql.includes('kind <> ALL')) {
          return { rows: state.unsupported || [] }
        }

        if (sql.includes('next_run_at IS NULL')) {
          return { rows: state.repair || [] }
        }

        return { rows: [] }
      }
    }
  }

  function makeTk (dbTimeOffsetMs: number, config: object = {}, state: FakeState = {}) {
    // manager is only used for the send-it insert, which the tests that need it replace
    const tk = new Timekeeper(makeDb(dbTimeOffsetMs, state) as any, {} as any, { schema: 'test', ...config } as any)
    ;(tk as any).stopped = false
    ;(tk as any).manager = { insert: async () => {} }
    return tk
  }

  // An occurrence that has only just passed, pinned half a second off the boundary: only a cron
  // occurrence exactly on the minute goes in the rolling-upgrade slot (see throttleSlot), and most
  // of these tests are not about that.
  function justPassed () {
    const now = Date.now()
    return new Date(now - (now % 1000) - 500)
  }

  /** The most recent minute boundary, which is what a 5-field cron expression always lands on. */
  function onTheMinute () {
    return new Date(Math.floor(Date.now() / 60_000) * 60_000)
  }

  // A claim row as the database hands it back, where `dueAt` is the occurrence taken and
  // `touchedAt` is when the row was last written. An hour back by default, which is a schedule that
  // has been running a while rather than one schedule() has only just anchored.
  function claimRow (overrides: object = {}) {
    return {
      name: 'q',
      key: '',
      kind: 'cron',
      expression: '* * * * *',
      timezone: 'UTC',
      data: null,
      options: {},
      dueAt: justPassed(),
      touchedAt: new Date(Date.now() - 3600_000),
      databaseTime: new Date(),
      ...overrides
    }
  }

  // A repair row as the database hands it back.
  function repairRow (overrides: object = {}) {
    return {
      name: 'q',
      key: '',
      kind: 'cron',
      expression: '* * * * *',
      timezone: 'UTC',
      databaseTime: new Date(),
      ...overrides
    }
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

  it('anchors a new schedule on the database clock, not the local one', async function () {
    const tk = makeTk(0)
    tk.clockSkew = 120_000 // db 2 minutes ahead of local

    let stored: Date | null = null
    ;(tk as any).db = {
      executeSql: async (sql: string, params: any[] = []) => {
        if (sql.includes('INSERT INTO')) {
          stored = params[7]
        }
        return { rows: [] }
      }
    }

    await tk.schedule('q', '* * * * *')

    // Computing the first occurrence from the local clock would put it two minutes early, and the
    // claim (which compares against the database clock) would fire it twice over.
    const skewed = Date.now() + 120_000
    expect(stored!.getTime()).toBeGreaterThan(skewed - 61_000)
    expect(stored!.getTime()).toBeLessThanOrEqual(skewed + 60_000)
  })

  it('fires an occurrence that has only just passed, so a schedule created after its boundary is not silent', async function () {
    const tk = makeTk(0)

    let stored: Date | null = null
    ;(tk as any).db = {
      executeSql: async (sql: string, params: any[] = []) => {
        if (sql.includes('INSERT INTO')) {
          stored = params[7]
        }
        return { rows: [] }
      }
    }

    await tk.schedule('q', '* * * * *')

    // The occurrence at the top of the current minute is in the past, which is exactly what the old
    // "did an occurrence pass in the last 60 seconds" evaluation acted on.
    expect(stored!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(stored!.getSeconds()).toBe(0)
  })

  it('does not manufacture a backlog for a recurrence faster than the grace window', async function () {
    const tk = makeTk(0, {
      recurrences: {
        // every two seconds, which fits inside the grace window thirty times over
        ticks: { next: (_e: string, after: Date) => new Date(after.getTime() + 2000) }
      }
    })

    let stored: Date | null = null
    ;(tk as any).db = {
      executeSql: async (sql: string, params: any[] = []) => {
        if (sql.includes('INSERT INTO')) {
          stored = params[7]
        }
        return { rows: [] }
      }
    }

    await tk.schedule('q', { kind: 'ticks', expression: '2s' })

    // Anchoring a grace window back would owe this schedule thirty occurrences before it had ever
    // run. Only the most recent occurrence counts, so the first one is still ahead.
    expect(stored!.getTime()).toBeGreaterThan(Date.now())
  })

  it('sends one job per claimed occurrence and advances the schedule', async function () {
    const state: FakeState = { claim: [claimRow()] }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    expect(inserted.length).toBe(1)
    expect(inserted[0].singletonKey).toBe('q__')

    expect(state.writes!.length).toBe(1)
    expect(state.writes![0].nextRunAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('gives an occurrence the same job id every time it is forwarded', async function () {
    const dueAt = justPassed()

    // The job the claimed occurrence turns into, on a pass of its own each time.
    async function forward (occurrence: Date) {
      const state: FakeState = { claim: [claimRow({ dueAt: occurrence })] }
      const tk = makeTk(0, {}, state)
      const inserted: any[] = []
      ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }
      await tk.cron()
      return inserted[0]
    }

    const first = await forward(dueAt)
    const second = await forward(dueAt)

    // Forwarding is not atomic with the claim, so an insert that commits and loses its
    // acknowledgement is handed back and re-forwarded by a later pass. The id is what makes the
    // repeat collapse on ON CONFLICT DO NOTHING instead of becoming a second job.
    expect(first.id).toBe(second.id)
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    // and a different occurrence of the same schedule is a different job
    const other = await forward(new Date(dueAt.getTime() - 30_000))

    expect(other.id).not.toBe(first.id)
  })

  it('files a cron occurrence on the minute in the slot a release before schema 40 would use', async function () {
    const dueAt = onTheMinute()
    const databaseTime = new Date()
    const state: FakeState = { claim: [claimRow({ dueAt, databaseTime })] }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    // An instance on pre-40 code keeps running against a 40 schema and forwards with
    // singletonSeconds: 60, so during a rolling upgrade both it and this pass can forward the same
    // occurrence. Reusing its minute slot is what collapses the pair.
    expect(inserted[0].singletonSeconds).toBe(60)

    // and the slot is pinned to the occurrence rather than to insert time, so a pass that straddles
    // a minute boundary does not file the occurrence under the following minute
    const slot = databaseTime.getTime() + inserted[0].singletonOffset * 1000
    expect(Math.floor(slot / 60_000)).toBe(dueAt.getTime() / 60_000)
  })

  it('leaves an occurrence off the minute out of that slot, which is what would throttle it', async function () {
    const state: FakeState = {
      claim: [claimRow({ kind: 'ticks', expression: '2', dueAt: justPassed() })]
    }
    const tk = makeTk(0, {
      recurrences: { ticks: { next: (e: string, after: Date) => new Date(after.getTime() + Number(e) * 1000) } }
    }, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    // A minute slot is exactly what capped a schedule at one job a minute, which is what the row
    // claim replaced it for.
    expect(inserted.length).toBeGreaterThanOrEqual(1)
    expect(inserted[0].singletonSeconds).toBeUndefined()
    expect(inserted[0].singletonOffset).toBeUndefined()
  })

  it('sends every occurrence a late pass arrived in time for, not just the one it claimed', async function () {
    // A kind finer than the grace window: three occurrences came due between the one claimed and
    // now, and all four were claimed inside the window, so none of them was missed.
    const dueAt = new Date(Date.now() - 8_000)
    const state: FakeState = { claim: [claimRow({ kind: 'ticks', expression: '2', dueAt })] }
    const tk = makeTk(0, {
      recurrences: { ticks: { next: (e: string, after: Date) => new Date(after.getTime() + Number(e) * 1000) } }
    }, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    // One job per pass would throttle a two-second kind to the monitor interval, which is the
    // throttle the row claim replaced.
    expect(inserted.length).toBeGreaterThanOrEqual(4)
    expect(state.writes![0].nextRunAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('skips a missed occurrence by default, says so, and still advances the schedule', async function () {
    const dueAt = new Date(Date.now() - 10 * 60 * 1000)
    const state: FakeState = { claim: [claimRow({ dueAt })] }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()

    // ten minutes of occurrences came due with nobody claiming; the default resumes at the next one
    expect(inserted.length).toBe(0)
    expect(state.writes![0].nextRunAt!.getTime()).toBeGreaterThan(Date.now())

    // and says which schedule lost which occurrence: skip is the default, so silence here is how a
    // deployment writes off occurrence after occurrence with nothing to show for it
    expect(warnings.length).toBe(1)
    expect(warnings[0].message).toMatch(/was skipped/)
    expect(warnings[0].data.dueAt).toBe(dueAt.toISOString())
  })

  it('skips a first occurrence nobody claimed in time, the same as any later one', async function () {
    // A schedule created a month before the outage that swallowed its occurrence. The row has never
    // fired, but that is not a reason to send a month-old occurrence under a policy documented as
    // sending nothing for the ones that were missed.
    const dueAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const state: FakeState = {
      claim: [claimRow({ dueAt, touchedAt: dueAt, expression: '0 3 * * *' })]
    }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }
    tk.on('warning', () => {})

    await tk.cron()

    expect(inserted.length).toBe(0)
    expect(state.writes![0].nextRunAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('sends the occurrence schedule() just anchored, however close to the window it already was', async function () {
    // schedule() deliberately looks back a whole grace window for the occurrence that has just
    // passed, so a schedule created at 03:00:59 anchors on 03:00:00 with a second of the window
    // left. Measuring lateness from the occurrence alone would drop it for the seconds a pass took
    // to get here, and `0 3 * * *` created a minute late would be silent until tomorrow.
    const dueAt = new Date(Date.now() - 90_000)
    const state: FakeState = {
      claim: [claimRow({ dueAt, touchedAt: new Date(Date.now() - 2000), expression: '0 3 * * *' })]
    }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    expect(inserted.length).toBe(1)
  })

  it('missed: once collapses a whole outage into a single job', async function () {
    const dueAt = new Date(Date.now() - 10 * 60 * 1000)
    const state: FakeState = {
      claim: [claimRow({ dueAt, options: { missed: 'once' } })]
    }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    expect(inserted.length).toBe(1)
    expect(state.writes![0].nextRunAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('missed: all sends one job per occurrence that came due', async function () {
    // aligned to a minute boundary so the count is exact rather than off by a partial minute
    const dueAt = new Date(onTheMinute().getTime() - 4 * 60_000)

    const state: FakeState = {
      claim: [claimRow({ dueAt, options: { missed: 'all' } })]
    }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    // the claimed occurrence plus the four that passed while it waited
    expect(inserted.length).toBe(5)
    // every one of them minute-aligned, so the rolling-upgrade slot cannot collapse two of them
    expect(new Set(inserted.map(j => j.singletonOffset)).size).toBe(5)
  })

  it('missed: all stops at the cap and says so', async function () {
    const dueAt = new Date(onTheMinute().getTime() - 5000 * 60_000)

    const state: FakeState = {
      claim: [claimRow({ dueAt, options: { missed: 'all' } })]
    }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()

    // a minutely schedule left alone for days is otherwise an unbounded insert
    expect(inserted.length).toBe(1000)
    expect(warnings.length).toBe(1)
    expect(warnings[0].message).toMatch(/more occurrences than one pass may send \(1000\)/)
    expect(state.writes![0].nextRunAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('caps a pass across schedules, not only within one', async function () {
    const dueAt = new Date(onTheMinute().getTime() - 5000 * 60_000)

    const state: FakeState = {
      claim: [
        claimRow({ name: 'first', dueAt, options: { missed: 'all' } }),
        claimRow({ name: 'second', dueAt, options: { missed: 'all' } }),
        claimRow({ name: 'third', dueAt, options: { missed: 'all' } })
      ]
    }
    const tk = makeTk(0, { maxCatchupOccurrences: 10 }, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }
    tk.on('warning', () => {})

    await tk.cron()

    // A per-schedule cap alone is one insert statement and one synchronous parser loop that both
    // scale with the number of schedules owed a catch-up: without a pass budget these three would
    // be thirty occurrences, and three hundred schedules three thousand.
    expect(inserted.filter(j => j.data.name === 'first').length).toBe(10)

    // The two behind it still get the occurrence they are actually due, so a long catch-up in front
    // of a schedule can never starve it. That is what bounds a pass at the cap or one per due
    // schedule, whichever is larger.
    expect(inserted.filter(j => j.data.name === 'second').length).toBe(1)
    expect(inserted.filter(j => j.data.name === 'third').length).toBe(1)
    expect(state.writes!.length).toBe(3)
  })

  it('stops a finite recurrence at its last occurrence instead of writing another one back', async function () {
    const state: FakeState = { claim: [claimRow({ kind: 'finite', expression: 'last' })] }
    const tk = makeTk(0, {
      // a recurrence with nothing after the occurrence just claimed
      recurrences: { finite: { next: () => null } }
    }, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    // the occurrence still fires; the row simply keeps the null the claim left behind, which is
    // what getSchedules() reports as a finished schedule
    expect(inserted.length).toBe(1)
    expect(state.writes!.length).toBe(0)
  })

  it('anchors past an occurrence claimed a moment before the clock says it is due', async function () {
    // The pass measures against an estimate of the database clock, so a claim can land fractionally
    // before the occurrence it just took. Anchoring on `now` alone would re-derive that same
    // occurrence and fire it a second time.
    const dueAt = new Date(Date.now() + 2000)
    const state: FakeState = {
      claim: [claimRow({ kind: 'ticks', expression: '2', dueAt, options: { missed: 'once' } })]
    }
    const tk = makeTk(0, {
      recurrences: { ticks: { next: (e: string, after: Date) => new Date(after.getTime() + Number(e) * 1000) } }
    }, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    expect(inserted.length).toBe(1)
    expect(state.writes![0].nextRunAt!.getTime()).toBe(dueAt.getTime() + 2000)
  })

  it('hands an occurrence back when the forward fails, rather than dropping it', async function () {
    const dueAt = justPassed()
    const state: FakeState = { claim: [claimRow({ dueAt })] }
    const tk = makeTk(0, {}, state)

    ;(tk as any).manager = { insert: async () => { throw new Error('insert failed') } }

    await expect(tk.cron()).rejects.toThrow('insert failed')

    // The claim has already cleared next_run_at, so advancing here would lose the occurrence for
    // good. It goes back exactly where it was for a later pass to re-claim.
    expect(state.writes!.length).toBe(1)
    expect(state.writes![0].nextRunAt!.getTime()).toBe(dueAt.getTime())
  })

  it('emits when the write that advances a schedule fails, rather than losing it silently', async function () {
    const state: FakeState = { claim: [claimRow()] }
    const tk = makeTk(0, {}, state)
    const inner = (tk as any).db

    ;(tk as any).db = {
      executeSql: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SET next_run_at')) {
          throw new Error('write failed')
        }
        return inner.executeSql(sql, params)
      }
    }
    ;(tk as any).manager = { insert: async () => {} }

    const errors: any[] = []
    tk.on('error', (e: any) => errors.push(e))

    await tk.cron()

    // The jobs are already durable, so the pass has nothing to undo and must not abort. The row
    // stays claimed for repair to re-anchor, but the failure still has to reach the error event.
    expect(errors.some(e => e.message === 'write failed')).toBe(true)
  })

  it('leaves a claimed occurrence for a later pass when the instance stops mid-pass', async function () {
    const dueAt = justPassed()
    const state: FakeState = { claim: [claimRow({ dueAt })] }
    const tk = makeTk(0, {}, state)

    // stop() landing between the claim and the forward: the jobs must not be queued once the
    // worker that would run them is gone, and the occurrence must go back rather than be written
    // off, since the claim has already cleared next_run_at.
    ;(tk as any).manager = { insert: async () => { throw new Error('must not forward after stop') } }
    ;(tk as any).stopped = true

    await tk.cron()

    expect(state.writes!.length).toBe(1)
    expect(state.writes![0].nextRunAt!.getTime()).toBe(dueAt.getTime())
  })

  it('keeps the warnings a failed pass already emitted from being emitted again on the next one', async function () {
    const state: FakeState = {
      repair: [repairRow({ name: 'broken', timezone: 'Mars/Phobos' })],
      claim: [claimRow()]
    }
    const tk = makeTk(0, {}, state)

    ;(tk as any).manager = { insert: async () => { throw new Error('insert failed') } }

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    // Throwing straight out of the pass would discard the suppression set, so the broken row would
    // warn (and persist a warning row) on every pass for as long as the insert kept failing, and
    // warningRetentionDays has no default to bound that.
    await expect(tk.cron()).rejects.toThrow('insert failed')
    await expect(tk.cron()).rejects.toThrow('insert failed')

    expect(warnings.length).toBe(1)
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

  it('schedule() rejects a kind with no registered parser', async function () {
    const tk = makeTk(0)

    await expect(tk.schedule('q', { kind: 'rrule', expression: 'FREQ=DAILY' })).rejects.toThrow(/Unknown recurrence kind "rrule"/)
  })

  it('schedule() rejects an unknown missed policy', async function () {
    const tk = makeTk(0)

    // @ts-expect-error the policy is a union, so this is only reachable from JavaScript
    await expect(tk.schedule('q', '* * * * *', null, { missed: 'sometimes' })).rejects.toThrow(/missed must be one of/)
  })

  it('schedule() runs a registered parser validate() and rejects what it throws on', async function () {
    const tk = makeTk(0, {
      recurrences: {
        rrule: {
          next: (_e: string, after: Date) => new Date(after.getTime() + 60_000),
          validate: (expression: string) => {
            if (!expression.startsWith('FREQ=')) {
              throw new Error('not an RRULE')
            }
          }
        }
      }
    })

    await expect(tk.schedule('q', { kind: 'rrule', expression: 'nope' })).rejects.toThrow('not an RRULE')
    await expect(tk.schedule('q', { kind: 'rrule', expression: 'FREQ=DAILY' })).resolves.toBeUndefined()
  })

  it('a parser that answers with something other than a date is treated as a broken schedule', async function () {
    const state: FakeState = {
      claim: [
        claimRow({ name: 'backwards', kind: 'backwards', expression: 'x' }),
        claimRow({ name: 'notadate', kind: 'notadate', expression: 'x' })
      ]
    }
    const tk = makeTk(0, {
      recurrences: {
        // a parser going backwards would spin the catch-up loop forever
        backwards: { next: (_e: string, after: Date) => new Date(after.getTime() - 1000) },
        // and one answering with a string would reach the schedule table as `Invalid Date`
        notadate: { next: () => 'next tuesday' }
      }
    }, state)

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()

    expect(warnings.length).toBe(2)
    expect(warnings.every(w => /could not be evaluated/.test(w.message))).toBe(true)
    expect(warnings.some(w => /is not after/.test(w.message))).toBe(true)
    expect(warnings.some(w => /instead of a Date or null/.test(w.message))).toBe(true)
  })

  it('one unusable schedule row does not stop every other schedule from firing', async function () {
    const state: FakeState = {
      claim: [
        claimRow({ name: 'broken', timezone: 'Mars/Phobos' }),
        claimRow({ name: 'healthy' })
      ]
    }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    // A row that predates validation (or was written straight to the table) carries a time zone
    // that throws once an occurrence is computed. It must be skipped, not allowed to abort the pass:
    // evaluation ran as one filter() over every schedule, so this single row silently stopped
    // scheduling for every queue in the whole deployment, on every pass, forever.
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
    const state: FakeState = { repair: [repairRow({ name: 'broken', timezone: 'Mars/Phobos' })] }
    const tk = makeTk(0, {}, state)

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    // Every other warning type describes something that clears itself: skew converges, a backlog
    // drains, a slow query is a one-off. A bad schedule row sits there until a human edits it, so
    // warning per pass would persist a row every cronMonitorIntervalSeconds forever, and
    // warningRetentionDays has no default to bound it.
    for (let i = 0; i < 5; i++) {
      await tk.cron()
    }

    expect(warnings.length).toBe(1)
  })

  it('a repaired schedule row warns again if it breaks a second time', async function () {
    const row = repairRow({ name: 'broken', timezone: 'Mars/Phobos' })
    const state: FakeState = { repair: [row] }
    const tk = makeTk(0, {}, state)

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()
    await tk.cron()
    expect(warnings.length).toBe(1)

    // fixed: the row drops out of the warned set, so the suppression must not outlive it
    row.timezone = 'UTC'
    await tk.cron()
    expect(warnings.length).toBe(1)

    // broken again, which is a fresh occurrence the operator has not seen
    row.timezone = 'Mars/Phobos'
    await tk.cron()
    expect(warnings.length).toBe(2)
  })

  it('editing an unusable schedule row into a different unusable state warns again', async function () {
    const row = repairRow({ name: 'broken', timezone: 'Mars/Phobos' })
    const state: FakeState = { repair: [row] }
    const tk = makeTk(0, {}, state)

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()

    // suppression keys on the whole row, so a failed repair attempt is reported rather than
    // swallowed as "already warned about that queue"
    row.timezone = 'America/New_Yrok'
    await tk.cron()

    expect(warnings.length).toBe(2)
    expect(warnings[1].data.timezone).toBe('America/New_Yrok')
  })

  it('start() re-surfaces a schedule row nobody has fixed', async function () {
    const state: FakeState = { repair: [repairRow({ name: 'broken', timezone: 'Mars/Phobos' })] }
    const tk = makeTk(0, {}, state)

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

  it('repair anchors a schedule that has no pending occurrence, without sending one', async function () {
    const state: FakeState = {
      repair: [repairRow()]
    }
    const tk = makeTk(0, {}, state)

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    await tk.cron()

    expect(state.writes!.length).toBe(1)
    expect(state.writes![0].nextRunAt!.getTime()).toBeGreaterThan(Date.now())
    // A claim that never reached the queue may equally well have reached it and died after, so
    // repair never replays the occurrence it found parked.
    expect(inserted.length).toBe(0)
  })

  it('warns about a due schedule whose kind this instance cannot evaluate', async function () {
    const state: FakeState = {
      unsupported: [{ name: 'q', key: 'weekly', kind: 'rrule', expression: 'FREQ=WEEKLY' }]
    }
    const tk = makeTk(0, {}, state)

    const warnings: any[] = []
    tk.on('warning', (w: any) => warnings.push(w))

    await tk.cron()

    expect(warnings.length).toBe(1)
    expect(warnings[0].message).toMatch(/recurrence kind "rrule"/)
    // nothing is claimed or advanced: the row is left for an instance that has the parser
    expect(state.writes!.length).toBe(0)

    // Warning alone leaves the occurrence to rot. The pass slot is deployment-wide, so this
    // instance has just spent the one pass of the interval on a row it cannot evaluate; releasing
    // the slot is what lets an instance that has the parser get there while the occurrence is still
    // inside the grace window, rather than roughly one interval per instance later.
    expect(state.released).toBe(1)
  })

  it('keeps the pass slot when every due schedule is one this instance can evaluate', async function () {
    const state: FakeState = { claim: [claimRow()] }
    const tk = makeTk(0, {}, state)

    ;(tk as any).manager = { insert: async () => {} }

    await tk.cron()

    // Releasing on every pass would multiply the claim query by the instance count for no reason.
    expect(state.released).toBeUndefined()
  })
})
