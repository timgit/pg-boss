import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss, TestClock } from '../src/index.ts'
import { delay } from '../src/tools.ts'
import { QUEUES } from '../src/timekeeper.ts'
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
  return await helper.start({ ...ctx.bossConfig, clock, schedule: true, cronMonitorIntervalSeconds: interval, cronWorkerIntervalSeconds: 1 })
}

/** The throttle slots the send-it queue holds for a schedule, oldest first, as `HH:MM`. */
async function slotsFiled (boss: PgBoss): Promise<string[]> {
  const { rows } = await boss.getDb().executeSql(
    `SELECT to_char(singleton_on, 'HH24:MI') AS slot FROM ${ctx.schema}.job WHERE name = $1 ORDER BY singleton_on`,
    [QUEUES.SEND_IT]
  )

  return rows.map(row => row.slot)
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
 * Moves the clock to `to` and waits for a pass to have run there and for its insert to have landed.
 *
 * The pass reads its time off this clock, which is at `to` by the time the claim has answered, but
 * the stamp the claim leaves on the version row is whatever job_now() read when the UPDATE landed,
 * and that races the tick's own push of `to` to the clock table. So the stamp says a pass claimed,
 * not where the clock was, and the wait is for it to have moved at all. The claim moves before the
 * pass evaluates, so a short real-time settle follows it.
 */
async function passAt (clock: TestClock, boss: PgBoss, to: number): Promise<void> {
  const before = await lastPass(boss)
  await clock.tick(to - clock.now())
  await until(async () => await lastPass(boss) > before)
  await delay(500)
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
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00'])

    // 12:01:15, in the next minute, while the occurrence is still inside the 60-second window.
    // Filed from insert time this lands in a slot of its own and is sent a second time.
    await passAt(clock, ctx.boss, T0 + 60 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00'])

    // On to the occurrence at 12:02:30, a tick at a time: a tick worth more than one interval runs
    // one pass all the same, and which instant that pass reads is the tick's race to lose.
    await passAt(clock, ctx.boss, T0 + 90 * SECOND)
    await passAt(clock, ctx.boss, T0 + 120 * SECOND)
    await passAt(clock, ctx.boss, T0 + 150 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00', '12:02'])
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
    await passAt(clock, ctx.boss, T0 + 60 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00'])

    // The pass that ends the gap owes the occurrence due now, 12:02:30, and the newest one the gap
    // held, 12:01:30, which the policy files under the minute it fell in. A repeat send of
    // 12:00:30 filed under 12:01 would already hold that slot, and the catch-up would be dropped.
    await clock.setTime(T0 + 170 * SECOND)
    await passAt(clock, ctx.boss, T0 + 180 * SECOND)

    expect(await slotsFiled(ctx.boss)).toEqual(['12:00', '12:01', '12:02'])
    expect(await filedSince(ctx.boss, T0 + 170 * SECOND)).toBe(2)
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
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00'])

    // A pass of this instance in the next minute names the slot the occurrence falls in, which is
    // the one the older instance's insert computed, so the two agree and the occurrence is sent
    // once. The other way round, the older instance files a second job under 12:01, which is what
    // two of them did before, and no more.
    await passAt(clock, ctx.boss, T0 + 65 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:00'])
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
    await passAt(clock, ctx.boss, T0 + 30 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual([])

    // 12:01:15, the first window to hold an occurrence, which is 12:01:00.
    await passAt(clock, ctx.boss, T0 + 60 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01'])

    // 12:01:45, answered with 12:01:00 again, in the minute already filed.
    await passAt(clock, ctx.boss, T0 + 90 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01'])

    // 12:02:15, a window holding 12:01:59 and 12:02:00, two occurrences a second apart in minutes
    // of their own. The read answers with 12:02:00 and passes over 12:01:59, whose minute the pass
    // at 12:01:15 filed.
    await passAt(clock, ctx.boss, T0 + 120 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01', '12:02'])

    // 12:03:15, answered with 12:02:59, which adds nothing for the same reason. Four occurrences
    // in two minutes are two jobs, which is the resolution the docs promise, and neither minute
    // was skipped by a read that answered with one occurrence out of two.
    await passAt(clock, ctx.boss, T0 + 150 * SECOND)
    await passAt(clock, ctx.boss, T0 + 180 * SECOND)
    expect(await slotsFiled(ctx.boss)).toEqual(['12:01', '12:02'])
  })
})
