import { expect } from 'vitest'
import { delay } from '../src/tools.ts'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import { ctx } from './hooks.ts'

// A recurrence kind registered by the process, the way work() handlers are. The expression is a
// plain interval in seconds, which is all these tests need from a parser: pg-boss never looks
// inside it.
const seconds = {
  next: (expression: string, after: Date) => new Date(after.getTime() + Number(expression) * 1000)
}

async function readSchedule (key = '') {
  const db = await helper.getDb()

  const { rows } = await db.executeSql(
    `SELECT kind, cron, next_run_at as "nextRunAt", last_run_at as "lastRunAt"
     FROM ${ctx.schema}.schedule WHERE name = $1 AND key = $2`,
    [ctx.schema, key]
  )

  await db.close()

  return rows[0]
}

async function execute (sql: string, values?: unknown[]) {
  const db = await helper.getDb()
  const result = await db.executeSql(sql, values)
  await db.close()
  return result
}

// Fetches until `expected` jobs have arrived or the deadline passes. Returns whatever it collected,
// so a test can assert on both too few and too many.
async function collectJobs (expected: number, timeoutMs = 20_000) {
  const collected: unknown[] = []
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline && collected.length < expected) {
    const jobs = await ctx.boss!.fetch(ctx.schema, { batchSize: 10 })

    collected.push(...jobs)

    if (collected.length < expected) {
      await delay(250)
    }
  }

  return collected
}

// Parks a schedule on an occurrence that came due while nothing was running. Aligned to a minute
// boundary so the number of occurrences a minutely expression missed is exact.
async function backdateSchedule (minutesAgo: number) {
  await execute(
    `UPDATE ${ctx.schema}.schedule
     SET next_run_at = date_trunc('minute', now()) - ($1 || ' minutes')::interval,
         last_run_at = date_trunc('minute', now()) - ($2 || ' minutes')::interval
     WHERE name = $3`,
    [minutesAgo, minutesAgo + 1, ctx.schema]
  )
}

describe('recurrence kinds', function () {
  it('sends jobs for a kind registered on the constructor', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true,
      recurrences: { seconds }
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, { kind: 'seconds', expression: '2' })

    const jobs = await collectJobs(1)

    expect(jobs.length).toBe(1)

    const schedule = await readSchedule()

    expect(schedule.kind).toBe('seconds')
    // the expression lives in the cron column whatever the kind
    expect(schedule.cron).toBe('2')
    expect(schedule.lastRunAt).toBeTruthy()
  })

  it('keeps firing a registered kind past the one-a-minute granularity cron evaluation had', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true,
      recurrences: { seconds }
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, { kind: 'seconds', expression: '1' })

    // Occurrences were deduplicated across instances with singletonSeconds: 60, which also meant a
    // schedule could not produce more than one job a minute. The row claim replaced it, so a
    // sub-minute kind gets every occurrence.
    const jobs = await collectJobs(3, 30_000)

    expect(jobs.length).toBeGreaterThanOrEqual(3)
  })

  it('reports a due schedule whose kind has no parser here, and leaves the row alone', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    // A row an instance elsewhere in the deployment wrote, with a parser this one does not have.
    await execute(
      `INSERT INTO ${ctx.schema}.schedule (name, key, kind, cron, timezone, data, options, next_run_at)
       VALUES ($1, '', 'rrule', 'FREQ=WEEKLY', 'UTC', null, '{}'::jsonb, now() - interval '1 minute')`,
      [ctx.schema]
    )

    const warnings: any[] = []
    ctx.boss.on('warning', (warning) => warnings.push(warning))

    const deadline = Date.now() + 20_000

    while (warnings.length === 0 && Date.now() < deadline) {
      await delay(250)
    }

    expect(warnings.length).toBeGreaterThanOrEqual(1)
    expect(warnings[0].message).toMatch(/recurrence kind "rrule"/)

    // Untouched, so an instance that does have the parser still finds the occurrence waiting, the
    // way a queue with no work() handler is simply not fetched.
    const schedule = await readSchedule()

    expect(schedule.nextRunAt).toBeTruthy()
    expect(schedule.lastRunAt).toBeNull()

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })

    expect(jobs.length).toBe(0)
  })

  it('rejects a kind with no registered parser at schedule() time', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(ctx.boss.schedule(ctx.schema, { kind: 'rrule', expression: 'FREQ=DAILY' }))
      .rejects.toThrow(/Unknown recurrence kind/)
  })

  it('rejects an expression the registered parser refuses', async function () {
    const config = {
      ...ctx.bossConfig,
      recurrences: {
        seconds: {
          ...seconds,
          validate: (expression: string) => {
            if (Number.isNaN(Number(expression))) {
              throw new Error('expression must be a number of seconds')
            }
          }
        }
      }
    }

    ctx.boss = await helper.start(config)

    await expect(ctx.boss.schedule(ctx.schema, { kind: 'seconds', expression: 'weekly' }))
      .rejects.toThrow('expression must be a number of seconds')

    const schedules = await ctx.boss.getSchedules()

    expect(schedules.length).toBe(0)
  })

  it('refuses to let a registered parser replace the built-in cron kind', async function () {
    expect(() => new PgBoss({
      ...ctx.bossConfig,
      recurrences: { cron: { next: () => new Date() } }
    })).toThrow(/built in/)
  })

  it('rejects a parser with no next function', async function () {
    // the parser shape is typed, so a parser with no next() is only reachable from JavaScript
    const recurrences = { rrule: { validate: () => {} } } as any

    expect(() => new PgBoss({ ...ctx.bossConfig, recurrences }))
      .toThrow(/next\(expression, after, tz\)/)
  })

  it('exposes the kind and occurrence timestamps on getSchedules', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.schedule(ctx.schema, '0 3 * * *', null, { tz: 'America/Chicago' })

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.kind).toBe('cron')
    expect(schedule.expression).toBe('0 3 * * *')
    // the old column name still reports the expression, so existing readers keep working
    expect(schedule.cron).toBe('0 3 * * *')
    expect(schedule.nextRunAt).toBeTruthy()
    expect(schedule.lastRunAt).toBeNull()
  })

  it('re-anchors a schedule that has no pending occurrence', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *')

    // The state every schedule is in immediately after the upgrade that added occurrence tracking,
    // and the state a process that dies between claiming and rescheduling leaves behind.
    await execute(`UPDATE ${ctx.schema}.schedule SET next_run_at = NULL WHERE name = $1`, [ctx.schema])

    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    })

    const deadline = Date.now() + 20_000
    let schedule = await readSchedule()

    while (!schedule.nextRunAt && Date.now() < deadline) {
      await delay(250)
      schedule = await readSchedule()
    }

    expect(schedule.nextRunAt).toBeTruthy()
    // repair never replays the occurrence it found parked
    expect(schedule.lastRunAt).toBeNull()
  })
})

describe('missed occurrences', function () {
  // Creates a minutely schedule without a running timekeeper, backdates it, then starts an instance
  // that will find the occurrences waiting.
  async function startWithMissedOccurrences (missed?: 'skip' | 'once' | 'all', minutesAgo = 3) {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, missed ? { missed } : {})

    await backdateSchedule(minutesAgo)

    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    })
  }

  it('skips them by default and resumes at the next occurrence', async function () {
    await startWithMissedOccurrences()

    // Long enough for several passes; the next real occurrence is up to a minute out, so nothing
    // should arrive in that time.
    await delay(6000)

    const jobs = await ctx.boss!.fetch(ctx.schema, { batchSize: 10 })

    expect(jobs.length).toBe(0)

    const schedule = await readSchedule()

    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('sends a single job for the whole outage with missed: once', async function () {
    await startWithMissedOccurrences('once')

    const jobs = await collectJobs(1)

    expect(jobs.length).toBe(1)

    // and only one: the catch-up must not repeat on the following passes
    await delay(3000)

    const more = await ctx.boss!.fetch(ctx.schema, { batchSize: 10 })

    expect(more.length).toBe(0)
  })

  it('sends one job per occurrence with missed: all', async function () {
    await startWithMissedOccurrences('all')

    // the claimed occurrence three minutes back, plus the two after it and the one at the current
    // minute boundary
    const jobs = await collectJobs(4)

    expect(jobs.length).toBe(4)
  })

  it('rejects an unknown missed policy', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // @ts-expect-error the policy is a union, so this is only reachable from JavaScript
    await expect(ctx.boss.schedule(ctx.schema, '* * * * *', null, { missed: 'eventually' }))
      .rejects.toThrow(/missed must be one of/)
  })
})
