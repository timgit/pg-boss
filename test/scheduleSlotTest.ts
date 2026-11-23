import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss, TestClock } from '../src/index.ts'
import { delay } from '../src/tools.ts'
import { QUEUES } from '../src/timekeeper.ts'
import * as plans from '../src/plans.ts'
import { isDistributedBackend, distributedTimeout } from './timeouts.ts'

const SECOND = 1_000

// A quarter past the minute. Every pass below lands on a quarter or three quarters of a minute and
// no occurrence these expressions have falls there, so the nearest is fifteen seconds away: a pass
// evaluates a few milliseconds before the instant it was armed for, since the claim timer measures
// from the stamp its claim left rather than from a grid, and on an occurrence's own instant that
// decides which of two a second apart the read answers with.
const T0 = Date.parse('2026-01-01T12:00:15Z')

/**
 * A scheduling instance whose passes and inserts both read `clock`.
 *
 * A pass every thirty seconds rather than every second, so each tick below advances the clock by
 * exactly one interval and runs exactly one pass. A tick worth several intervals runs a different
 * number of them depending on whether the driver's queries settle inside it, which is a difference
 * between PGlite and postgres rather than one this file is about.
 */
async function startScheduling (clock: TestClock, interval = 30): Promise<PgBoss> {
  const boss = await helper.start({ ...ctx.bossConfig, clock, schedule: true, cronMonitorIntervalSeconds: interval })

  passes.set(boss, watchPasses(boss))

  return boss
}

/**
 * The schedule reads and slot inserts an instance has issued, and the latest of each to resolve,
 * numbered in the order they were issued.
 */
type Passes = { reads: number, inserts: number, readDone: number, insertDone: number }

const passes = new WeakMap<PgBoss, Passes>()

/**
 * Watches the statements an instance's database object runs, which is the one its timekeeper
 * holds, for the two that mark a pass.
 *
 * A pass reads every schedule and, when anything new came due, sends it with the cron statement,
 * the only one that declares the bridge slot column. So a pass that sends is over once that
 * statement has resolved, and one that sends nothing is over once its read has: what follows the
 * read is synchronous up to the send-it drain, which tests wait for on its own. Numbered by issue
 * so a statement a pass before the tick left in flight cannot stand in for one of the pass after
 * it.
 */
function watchPasses (boss: PgBoss): Passes {
  const db = boss.getDb()
  const executeSql = db.executeSql.bind(db)
  const read = plans.getSchedules(ctx.schema)
  const counts = { reads: 0, inserts: 0, readDone: -1, insertDone: -1 }

  db.executeSql = async (sql: string, values?: unknown[]) => {
    const readIndex = sql === read ? counts.reads++ : -1
    const insertIndex = sql.includes('"bridgeSlot" text') ? counts.inserts++ : -1

    const result = await executeSql(sql, values)

    counts.readDone = Math.max(counts.readDone, readIndex)
    counts.insertDone = Math.max(counts.insertDone, insertIndex)

    return result
  }

  return counts
}

/**
 * The throttle slots the send-it queue holds, oldest first, as `HH:MM:SS`. A slot a minute wide
 * reads as the minute's first second. Each job the cron statement sends leaves a completed row in
 * its slot, and an older instance's job holds one too.
 */
async function slotsFiled (boss: PgBoss): Promise<string[]> {
  const { rows } = await boss.getDb().executeSql(
    `SELECT to_char(singleton_on, 'HH24:MI:SS') AS slot FROM ${ctx.schema}.job WHERE name = $1 ORDER BY singleton_on`,
    [QUEUES.SEND_IT]
  )

  return rows.map(row => row.slot)
}

/** How many jobs a queue holds. */
async function jobsIn (name: string): Promise<number> {
  return await helper.countJobs(ctx.schema, 'job', 'name = $1', [name])
}

/** How many send-it rows were filed at or after `since`, on the clock the inserts read. */
async function filedSince (boss: PgBoss, since: number): Promise<number> {
  const { rows } = await boss.getDb().executeSql(
    `SELECT count(*)::int AS n FROM ${ctx.schema}.job WHERE name = $1 AND created_on >= $2`,
    [QUEUES.SEND_IT, new Date(since).toISOString()]
  )

  return Number(rows[0].n)
}

/** When an instance last claimed a pass, off the version row. */
async function lastPass (boss: PgBoss): Promise<number> {
  const { rows } = await boss.getDb().executeSql(`SELECT cron_on FROM ${ctx.schema}.version`)

  return new Date(rows[0].cron_on).getTime()
}

// Real-time wait for I/O a tick started; tick itself never waits on I/O.
async function until (predicate: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('until: condition not met')
    await delay(10)
  }
}

/**
 * Moves the clock to `to` and waits for the pass that runs there to be over.
 *
 * `inserts` says whether that pass sends, which decides what its end looks like: the cron
 * statement resolving, or the schedule read resolving when there is nothing new to send. A pass
 * that finds an occurrence this instance already sent runs no statement.
 */
async function passAt (clock: TestClock, boss: PgBoss, to: number, inserts = true): Promise<void> {
  const counts = passes.get(boss)!
  const before = { ...counts }

  await clock.tick(to - clock.now())
  await until(async () => inserts ? counts.insertDone >= before.inserts : counts.readDone >= before.reads)
}

// Each test here starts an instance and walks it through five or six passes, waiting on a database
// round trip for each one, which is a couple of seconds on an idle machine against a 10s global
// budget. That headroom disappears on a loaded one, where the file runs beside the rest of the
// suite against one server, so the longest test times out rather than fails. Raise the budget for
// the block.
//
// Lifting only, per the rule in test/timeouts.ts: a block value replaces the global in both
// directions, and a flat 30s would cap a distributed backend at a quarter of what it is given.
const blockTimeout = isDistributedBackend ? distributedTimeout : 30000

describe('schedule slot', { timeout: blockTimeout }, function () {
  it('files a cron occurrence under the minute it falls in, whichever minute the passes run in', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await startScheduling(clock)

    // The pass start() runs before anything below stamps the version row off the test clock.
    // Waiting for it fixes what it saw, and keeps the first tick below from being taken for it.
    await until(async () => await lastPass(ctx.boss!) === T0)

    // Every other minute on the half minute, so the two occurrences in the run are further apart
    // than the window and a repeat send of either cannot hide behind the other.
    await ctx.boss.schedule(ctx.schema, '30 */2 * * * *')

    // 12:00:45, a pass in the same minute as the occurrence at 12:00:30.
    await passAt(clock, ctx.boss, T0 + 30 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00'])

    // 12:01:15, in the next minute, while the occurrence is still inside the 60-second window. The
    // cursor has passed it, so nothing is sent a second time.
    await passAt(clock, ctx.boss, T0 + 60 * SECOND, false)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00'])

    // On to the occurrence at 12:02:30, a tick at a time: a tick worth more than one interval runs
    // one pass all the same, and which instant that pass reads is the tick's race to lose.
    await passAt(clock, ctx.boss, T0 + 90 * SECOND, false)
    await passAt(clock, ctx.boss, T0 + 120 * SECOND, false)
    await passAt(clock, ctx.boss, T0 + 150 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00', '12:02:00'])
    expect(await jobsIn(ctx.schema)).toBe(2)
  })

  it('catches up on an occurrence in the middle of a minute', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await startScheduling(clock)

    // The pass start() runs before anything below stamps the version row off the test clock.
    // Waiting for it fixes what it saw, and keeps the first tick below from being taken for it.
    await until(async () => await lastPass(ctx.boss!) === T0)

    // Stored after that pass, so the only occurrences in play are the ones the ticks below reach.
    await ctx.boss.schedule(ctx.schema, '30 * * * * *', null, { missed: 'once' })

    // Two passes either side of the minute boundary after 12:00:30, then nothing until 12:03:05.
    await passAt(clock, ctx.boss, T0 + 30 * SECOND)
    await passAt(clock, ctx.boss, T0 + 60 * SECOND, false)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00'])

    // The pass that ends the gap owes the newest occurrence since it opened, 12:02:30, which is
    // due now. The policy sends one job for it rather than one for 12:01:30 as well.
    await clock.setTime(T0 + 170 * SECOND)
    await passAt(clock, ctx.boss, T0 + 180 * SECOND)

    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00', '12:02:00'])
    expect(await filedSince(ctx.boss, T0 + 170 * SECOND)).toBe(1)
    expect(await jobsIn(ctx.schema)).toBe(2)
  })

  it('collapses into the job an older instance filed from insert time', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await startScheduling(clock)

    // The pass start() runs before anything below stamps the version row off the test clock.
    // Waiting for it fixes what it saw, and keeps the first tick below from being taken for it.
    await until(async () => await lastPass(ctx.boss!) === T0)

    await ctx.boss.createQueue('q')
    await ctx.boss.schedule('q', '30 */2 * * * *')

    // What an instance on a release that files a cron occurrence from insert time puts on the
    // send-it queue when it finds 12:00:30 in the same minute: the 60-second throttle, and the
    // singleton key the pass builds from the queue name and an empty key. The clock jumps rather
    // than ticks, so no pass of this instance runs first.
    await clock.setTime(T0 + 35 * SECOND)
    await ctx.boss.insert(QUEUES.SEND_IT, [{ data: { name: 'q', key: '', data: null, options: {} }, singletonKey: 'q__', singletonSeconds: 60 }])
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00'])

    // A pass of this instance in the next minute names the slot the occurrence falls in, which is
    // the one the older instance's insert computed. The send-it job there keeps this instance from
    // sending the occurrence itself, and the pass forwards that job instead, so the occurrence is
    // sent once.
    await passAt(clock, ctx.boss, T0 + 65 * SECOND)
    await until(async () => await jobsIn('q') === 1)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00'])

    const [forwarded] = await ctx.boss.findJobs(QUEUES.SEND_IT)
    expect(forwarded.state).toBe('completed')
  })

  it('drops an older instance\'s send-it job for an occurrence it already sent', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await startScheduling(clock)

    await until(async () => await lastPass(ctx.boss!) === T0)

    await ctx.boss.createQueue('q')
    await ctx.boss.schedule('q', '30 */2 * * * *')

    // 12:00:45, this instance sends 12:00:30 and leaves a completed send-it row in its slot.
    await passAt(clock, ctx.boss, T0 + 30 * SECOND)
    expect(await jobsIn('q')).toBe(1)

    // 12:00:55, an older instance files the same occurrence from insert time, in the same minute.
    // Its insert conflicts with the completed row and is dropped, so nothing is left to forward.
    await clock.setTime(T0 + 40 * SECOND)
    await ctx.boss.insert(QUEUES.SEND_IT, [{ data: { name: 'q', key: '', data: null, options: {} }, singletonKey: 'q__', singletonSeconds: 60 }])
    expect(await helper.countJobs(ctx.schema, 'job', 'name = $1 AND state = $2', [QUEUES.SEND_IT, 'created'])).toBe(0)

    await passAt(clock, ctx.boss, T0 + 60 * SECOND, false)
    expect(await jobsIn('q')).toBe(1)
  })

  it('sends no more beside an older instance filing after it than two older instances send', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await startScheduling(clock)

    // The pass start() runs before anything below stamps the version row off the test clock.
    // Waiting for it fixes what it saw, and keeps the first tick below from being taken for it.
    await until(async () => await lastPass(ctx.boss!) === T0)

    await ctx.boss.createQueue('q')
    await ctx.boss.schedule('q', '30 */2 * * * *')

    // 12:00:45, this instance files 12:00:30 under the minute it falls in.
    await passAt(clock, ctx.boss, T0 + 30 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00'])

    // 12:01:05, an instance on a release that files from insert time finds the same occurrence
    // still inside its window and files it under the minute it runs in. That is the second job two
    // such instances file for this occurrence, as the first test here shows of one, so the mixed
    // deployment sends what an unmixed older one does. The clock jumps rather than ticks, so no
    // pass of this instance runs first.
    await clock.setTime(T0 + 50 * SECOND)
    await ctx.boss.insert(QUEUES.SEND_IT, [{ data: { name: 'q', key: '', data: null, options: {} }, singletonKey: 'q__', singletonSeconds: 60 }])
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00', '12:01:00'])

    // 12:01:15, this instance finds the occurrence again behind its cursor and sends nothing, so
    // the older instance's job, which the pass forwards, is the only extra one.
    await passAt(clock, ctx.boss, T0 + 60 * SECOND, false)
    await until(async () => await jobsIn('q') === 2)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00:00', '12:01:00'])
  })

  it('files each minute of an expression whose occurrences land either side of one', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await startScheduling(clock)

    // Two occurrences a second apart either side of a minute, and in those two minutes only, so
    // the pass that runs on start reads an empty window whether or not it beats this insert.
    await ctx.boss.schedule(ctx.schema, '0,59 1,2 * * * *')

    // That pass stamps the version row off the test clock, so waiting for the stamp keeps the
    // first tick below from being taken for it.
    await until(async () => await lastPass(ctx.boss!) === T0)
    expect(await slotsFiled(ctx.boss)).toEqual([])

    // 12:00:45, still before the first occurrence.
    await passAt(clock, ctx.boss, T0 + 30 * SECOND, false)
    expect(await slotsFiled(ctx.boss)).toEqual([])

    // 12:01:15, the first window to hold an occurrence, which is 12:01:00.
    await passAt(clock, ctx.boss, T0 + 60 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01:00'])

    // 12:01:45, answered with 12:01:00 again, which this instance already sent.
    await passAt(clock, ctx.boss, T0 + 90 * SECOND, false)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01:00'])

    // 12:02:15, a window holding 12:01:59 and 12:02:00, two occurrences a second apart in minutes
    // of their own. The read answers with 12:02:00 and passes over 12:01:59, whose minute the pass
    // at 12:01:15 filed.
    await passAt(clock, ctx.boss, T0 + 120 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01:00', '12:02:00'])

    // 12:03:15, answered with 12:02:59, which moves the cursor and adds no job for the same
    // reason. Four occurrences in two minutes are two jobs, which is the resolution the docs
    // promise, and neither minute was skipped by a read that answered with one occurrence out of
    // two.
    await passAt(clock, ctx.boss, T0 + 150 * SECOND, false)
    await passAt(clock, ctx.boss, T0 + 180 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01:00', '12:02:00'])
    expect(await jobsIn(ctx.schema)).toBe(2)
  })

  /**
   * Passes over both 01:30s of the night New York goes back for an expression holding that minute,
   * answering with the slots filed. At 02:00 EDT on 2026-11-01 New York goes back to 01:00 EST, and
   * 01:30 comes round twice, at 05:30 and at 06:30 UTC. `sendsSecond` says whether the expression
   * sends the second one.
   *
   * The hour between the two jumps with setTime(). Ticking through it costs a pass every thirty
   * seconds, each a database round trip. The rule for every expression is covered
   * over a mocked database in scheduleSecondTest, and these two run it through real passes.
   */
  async function slotsOverRepeatedHour (expression: string, sendsSecond: boolean): Promise<string[]> {
    // 01:29:45 EDT.
    const start = Date.parse('2026-11-01T05:29:45Z')
    const clock = new TestClock(start)
    ctx.boss = await startScheduling(clock)

    await until(async () => await lastPass(ctx.boss!) === start)

    await ctx.boss.schedule(ctx.schema, expression, null, { tz: 'America/New_York' })

    // 01:30:15 EDT, the first 01:30.
    await passAt(clock, ctx.boss, start + 30 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['05:30:00'])

    // On to 01:29:45 EST. The overdue timers fire once at the next tick, which runs the pass there
    // before the one at the second 01:30. The gap since the last pass changes nothing for a minute
    // schedule under the default `missed`.
    await clock.setTime(start + 3600 * SECOND)
    await passAt(clock, ctx.boss, start + 3630 * SECOND, sendsSecond)
    // The second 01:30 again, which the cursor has passed.
    await passAt(clock, ctx.boss, start + 3660 * SECOND, false)

    const counts = passes.get(ctx.boss)!
    await until(async () => counts.insertDone === counts.inserts - 1)

    return await slotsFiled(ctx.boss)
  }

  it('sends a daily occurrence once on the night the clocks go back', async function () {
    expect(await slotsOverRepeatedHour('30 1 * * *', false)).toEqual(['05:30:00'])
  })

  it('keeps sending through the repeated hour for an expression naming every hour', async function () {
    expect(await slotsOverRepeatedHour('30 * * * *', true)).toEqual(['05:30:00', '06:30:00'])
  })

  /**
   * Runs the pass at 03:30:15 EDT on the night New York springs forward, answering with the slots
   * filed. At 02:00 EST on 2026-03-08 the clocks go to 03:00 EDT, and 02:30 doesn't exist.
   * `previewSchedule()` lists `30 2 * * *` at 03:30 EDT (07:30 UTC), because cron-parser's next()
   * moves a skipped time into the hour the clocks land on. The pass reads with prev(), which skips
   * it. These tests pin the skip so a cron-parser release that changes either read fails here.
   */
  async function slotsOverSkippedHour (expression: string, inserts: boolean): Promise<string[]> {
    // 01:59:45 EST.
    const start = Date.parse('2026-03-08T06:59:45Z')
    const clock = new TestClock(start)
    ctx.boss = await startScheduling(clock)

    await until(async () => await lastPass(ctx.boss!) === start)

    await ctx.boss.schedule(ctx.schema, expression, null, { tz: 'America/New_York' })

    // On to 03:29:45 EDT, then the pass at 03:30:15 EDT.
    await clock.setTime(Date.parse('2026-03-08T07:29:45Z'))
    await passAt(clock, ctx.boss, Date.parse('2026-03-08T07:30:15Z'), inserts)

    return await slotsFiled(ctx.boss)
  }

  it('sends nothing on the night the clocks skip the time a daily expression names', async function () {
    expect(await slotsOverSkippedHour('30 2 * * *', false)).toEqual([])
  })

  it('sends a daily occurrence after the clocks spring forward when its time exists', async function () {
    expect(await slotsOverSkippedHour('30 3 * * *', true)).toEqual(['07:30:00'])
  })
})
