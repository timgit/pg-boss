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

/**
 * An hourly cron expression whose boundary sits half an hour away from now, in both directions.
 *
 * A minutely expression would make every catch-up assertion a race against the wall clock: the next
 * real occurrence is at most a minute out, so a test that collects jobs and then checks that no
 * more arrive fails whenever it happens to run across a minute boundary. Half an hour of margin on
 * either side makes the occurrence count exact and the "and no more" assertions deterministic.
 */
function hourlySchedule () {
  const minute = (new Date().getUTCMinutes() + 30) % 60

  // The most recent occurrence, which is always about thirty minutes back.
  const previous = new Date()
  previous.setUTCSeconds(0, 0)
  previous.setUTCMinutes(minute)

  if (previous.getTime() > Date.now()) {
    previous.setUTCHours(previous.getUTCHours() - 1)
  }

  return { expression: `${minute} * * * *`, previous }
}

// Parks a schedule on an occurrence that came due while nothing was claiming. updated_on is aged
// along with the rest: the grace window runs from the later of the occurrence and the moment the
// row was written, so a row still carrying the timestamp schedule() gave it a second ago is one
// nothing could have missed yet, whatever its next_run_at says.
async function backdateSchedule (previous: Date, hoursAgo: number) {
  const nextRunAt = new Date(previous.getTime() - hoursAgo * 3600_000)
  const before = new Date(nextRunAt.getTime() - 3600_000)

  await execute(
    `UPDATE ${ctx.schema}.schedule SET next_run_at = $1, last_run_at = $2, updated_on = $2 WHERE name = $3`,
    [nextRunAt, before, ctx.schema]
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

  it('reports an expression with no reachable occurrence as an expression problem', async function () {
    const config = {
      ...ctx.bossConfig,
      recurrences: {
        // validate() is optional and only judges shape, so an expression that parses and then has
        // no occurrence at all gets this far. On its own that surfaces as a raw parser message
        // thrown from a code path with nothing to say the caller's expression was the problem.
        finite: {
          next: () => { throw new Error('Out of the timespan range') },
          validate: () => {}
        }
      }
    }

    ctx.boss = await helper.start(config)

    await expect(ctx.boss.schedule(ctx.schema, { kind: 'finite', expression: 'never' }))
      .rejects.toThrow(/Recurrence expression "never" has no usable first occurrence: Out of the timespan range/)

    const schedules = await ctx.boss.getSchedules()

    expect(schedules.length).toBe(0)
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
  // Creates an hourly schedule without a running timekeeper, backdates it, then starts an instance
  // that will find the occurrences waiting.
  async function startWithMissedOccurrences (missed?: 'skip' | 'once' | 'all', hoursAgo = 3, config: object = {}) {
    const { expression, previous } = hourlySchedule()

    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, expression, null, missed ? { missed } : {})

    await backdateSchedule(previous, hoursAgo)

    await ctx.boss.stop({ graceful: false })

    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true,
      ...config
    })

    return previous
  }

  it('skips them by default and resumes at the next occurrence', async function () {
    await startWithMissedOccurrences()

    // Long enough for several passes; the next real occurrence is half an hour out, so nothing
    // should arrive in that time.
    await delay(6000)

    const jobs = await ctx.boss!.fetch(ctx.schema, { batchSize: 10 })

    expect(jobs.length).toBe(0)

    const schedule = await readSchedule()

    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('says which schedule lost which occurrence when the default skips it', async function () {
    // Read back from the warning table rather than the event: the drop happens on the very first
    // pass, which a listener attached after start() would have already missed, and warnOnce never
    // repeats it.
    const previous = await startWithMissedOccurrences(undefined, 3, { persistWarnings: true })

    const deadline = Date.now() + 20_000
    let rows: any[] = []

    while (rows.length === 0 && Date.now() < deadline) {
      await delay(250)
      const result = await execute(
        `SELECT type, message, data FROM ${ctx.schema}.warning WHERE type = 'missed_occurrences_skipped'`
      )
      rows = result.rows
    }

    // skip is the default, so silence here is how a deployment writes off occurrence after
    // occurrence with nothing at all to show for it.
    expect(rows.length).toBe(1)
    expect(rows[0].message).toMatch(/was skipped/)
    expect(rows[0].data.queue).toBe(ctx.schema)
    expect(new Date(rows[0].data.dueAt).getTime()).toBe(previous.getTime() - 3 * 3600_000)
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

    // the claimed occurrence three hours back, plus the two after it and the most recent one
    const jobs = await collectJobs(4)

    expect(jobs.length).toBe(4)

    // and no fifth: the next occurrence is half an hour out
    await delay(3000)

    const more = await ctx.boss!.fetch(ctx.schema, { batchSize: 10 })

    expect(more.length).toBe(0)
  })

  it('rejects an unknown missed policy', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // @ts-expect-error the policy is a union, so this is only reachable from JavaScript
    await expect(ctx.boss.schedule(ctx.schema, '* * * * *', null, { missed: 'eventually' }))
      .rejects.toThrow(/missed must be one of/)
  })
})
