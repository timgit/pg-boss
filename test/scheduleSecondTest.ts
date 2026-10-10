import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss, TestClock } from '../src/index.ts'
import Timekeeper, { QUEUES } from '../src/timekeeper.ts'
import { systemClock } from '../src/clock.ts'
import { delay } from '../src/tools.ts'
import * as plans from '../src/plans.ts'
import type { Clock, ClockTimer } from '../src/types.ts'
import { isDistributedBackend, distributedTimeout } from './timeouts.ts'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE

/**
 * A Timekeeper over a database that answers the clock query and records every statement, with the
 * insert the pass and the per-second evaluation make captured instead of run.
 */
function makeTk (clock: Clock = systemClock) {
  const executed: Array<{ sql: string, params: unknown[] }> = []
  const inserted: any[] = []

  const db = {
    executeSql: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params })

      return { rows: [{ time: String(Date.now()) }] }
    }
  }

  const manager = {
    insert: async (_queue: string, jobs: any[]) => { inserted.push(...jobs) },
    offWork: async () => {}
  }

  const tk = new Timekeeper(db as any, manager as any, { schema: 'test', clock, cronMonitorIntervalSeconds: 30 } as any)

  ;(tk as any).stopped = false

  return Object.assign(tk, { executed, inserted })
}

/** One schedule row, as getSchedules() hands it to the pass. */
function row (cron: string, extra: Record<string, unknown> = {}) {
  return { name: 'q', key: '', data: null, options: {}, kind: plans.SCHEDULE_KINDS.cron, cron, timezone: 'UTC', ...extra }
}

/** A pass at `databaseTime` after the one at `priorCronOn`, answering with the slots it filed. */
async function pass (tk: ReturnType<typeof makeTk>, databaseTime: number, priorCronOn: number | null, schedules: unknown[]) {
  const before = tk.inserted.length

  tk.clockSkew = databaseTime - tk.config.clock.now()

  await tk.cron(priorCronOn === null ? null : new Date(priorCronOn), schedules as any)

  return tk.inserted.slice(before).map(job => job.__singletonSlot)
}

/** A slot as the insert files it: UTC wall time, without a zone, `width` seconds wide. */
function slotOf (epochMs: number, width = 1) {
  return new Date(Math.floor(epochMs / (width * 1000)) * width * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

/** The second slots of every whole second in (after, until]. */
function secondsIn (after: number, until: number) {
  const slots: string[] = []

  for (let t = Math.floor(after / SECOND) * SECOND + SECOND; t <= until; t += SECOND) {
    slots.push(slotOf(t))
  }

  return slots
}

describe('schedule seconds', function () {
  it('files every occurrence of an expression with a seconds field in a slot of its own', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    // A pass reads from the last one, so the occurrences between the two are each owed, rather
    // than the newest in the window filed under the minute.
    const filed = await pass(tk, now, now - 30 * SECOND, [row('*/15 * * * * *')])

    expect(filed).toEqual([slotOf(minute + 15 * SECOND), slotOf(minute + 30 * SECOND)])
  })

  it('keeps an expression whose seconds field is only 0 with the pass, and reads an alias by what it expands to', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    const filed = async (cron: string) => await pass(makeTk(), now, now - 2 * SECOND, [row(cron)])

    // Every occurrence of these is on :00, where a minute slot and a second slot name the same
    // instant, so they stay with the pass and file the newest occurrence in the window.
    for (const cron of ['0 * * * * *', '@minutely', '* * * * *']) {
      expect(await filed(cron), cron).toEqual([slotOf(minute, 60)])
    }

    // These name seconds other than 0, the alias included.
    expect(await filed('@secondly')).toEqual([slotOf(now - SECOND), slotOf(now)])
    expect(await filed('0,30 * * * * *')).toEqual([slotOf(now)])

    // A rule stays with the pass whatever its seconds: a job for each minute the window holds
    // an occurrence in, which for a rule every second is the two minutes the window spans.
    const rule = row('FREQ=SECONDLY', { kind: plans.SCHEDULE_KINDS.rrule })
    expect(await pass(tk, now, now - 2 * SECOND, [rule])).toEqual([slotOf(minute - MINUTE, 60), slotOf(minute, 60)])
  })

  it('does not reach back past the due window or the moment the schedule was stored', async function () {
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    // Ten minutes since the last pass: the window's 60 seconds are owed, and anything older is left
    // to the missed policy, which is skip here.
    expect(await pass(makeTk(), now, now - 10 * MINUTE, [row('* * * * * *')])).toEqual(secondsIn(now - MINUTE, now))

    // Nor past it for an instance that evaluated the row ten minutes ago and has not held the claim
    // since: every bound below the window reads as the window.
    const stale = makeTk()
    ;(stale as any).secondCronEvaluatedTo = new Map([[JSON.stringify(['q', '']), now - 10 * MINUTE]])
    expect(await pass(stale, now, now - 10 * MINUTE, [row('* * * * * *', { createdOn: new Date(now - DAY) })])).toEqual(secondsIn(now - MINUTE, now))

    // A schedule stored five seconds ago owes the five seconds since, not the half minute since the
    // last pass: occurrences before the row existed are of an expression that was not in the table.
    const created = now - 5 * SECOND
    expect(await pass(makeTk(), now, now - 30 * SECOND, [row('* * * * * *', { createdOn: new Date(created) })])).toEqual(secondsIn(created, now))
  })

  it('reads on from where it last evaluated, and reads a range again when its insert failed', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    expect(await pass(tk, now, now - 3 * SECOND, [row('* * * * * *')])).toEqual(secondsIn(now - 3 * SECOND, now))

    // The next pass of the same instance owes only what came due since, whatever its claim says.
    expect(await pass(tk, now + 2 * SECOND, now - 10 * SECOND, [row('* * * * * *')])).toEqual(secondsIn(now, now + 2 * SECOND))

    // An insert that fails leaves the range where it was, so the next evaluation sends it.
    const insert = tk.manager.insert
    tk.manager.insert = async () => { throw new Error('insert failed') }

    await expect(pass(tk, now + 4 * SECOND, null, [row('* * * * * *')])).rejects.toThrow('insert failed')

    tk.manager.insert = insert

    expect(await pass(tk, now + 5 * SECOND, null, [row('* * * * * *')])).toEqual(secondsIn(now + 2 * SECOND, now + 5 * SECOND))
  })

  it('skips and warns about a row whose occurrences cannot be read, and sends the others', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    const warnings: any[] = []
    tk.on('warning', warning => warnings.push(warning))

    // An expression the due read accepts is read the same way here, so the failure is injected on
    // this read alone.
    const secondCronDue = (tk as any).secondCronDue.bind(tk)
    ;(tk as any).secondCronDue = (schedule: any, ...rest: unknown[]) => {
      if (schedule.name === 'broken') throw new Error('unreadable')

      return secondCronDue(schedule, ...rest)
    }

    const filed = await pass(tk, now, now - SECOND, [row('* * * * * *', { name: 'broken' }), row('* * * * * *')])

    expect(filed).toEqual([slotOf(now)])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/schedule for queue "broken" \(key ""\) could not be evaluated and was skipped: unreadable/)
  })

  it('evaluates every second while the lease lasts and nothing once it has run out', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    tk.clockSkew = now - Date.now()

    ;(tk as any).secondCronCache = [row('* * * * * *'), row('* * * * * *', { name: 'broken' })]
    ;(tk as any).secondCronEvaluatedTo = new Map([[JSON.stringify(['q', '']), now - 2 * SECOND]])
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    // A row whose read fails is passed over without failing the others: the pass that cached it
    // read it the same way and warned.
    const secondCronDue = (tk as any).secondCronDue.bind(tk)
    ;(tk as any).secondCronDue = (schedule: any, ...rest: unknown[]) => {
      if (schedule.name === 'broken') throw new Error('unreadable')

      return secondCronDue(schedule, ...rest)
    }

    await tk.onSecond()
    expect(tk.inserted.map(job => job.__singletonSlot)).toEqual(secondsIn(now - 2 * SECOND, now))

    // The next tick reads on from there, so within the same second it owes nothing.
    await tk.onSecond()
    expect(tk.inserted).toHaveLength(2)

    ;(tk as any).leaseUntil = Date.now()

    await tk.onSecond()
    expect(tk.inserted).toHaveLength(2)
  })

  it('reports a failed per-second insert and reads the range again', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    const errors: any[] = []
    tk.on('error', err => errors.push(err))

    tk.clockSkew = now - Date.now()

    ;(tk as any).secondCronCache = [row('* * * * * *')]
    ;(tk as any).secondCronEvaluatedTo = new Map([[JSON.stringify(['q', '']), now - SECOND]])
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    const insert = tk.manager.insert
    tk.manager.insert = async () => { throw new Error('insert failed') }

    await tk.onSecond()

    expect(errors.map(err => err.message)).toEqual(['insert failed'])

    tk.manager.insert = insert

    await tk.onSecond()
    expect(tk.inserted.map(job => job.__singletonSlot)).toEqual([slotOf(now)])
  })

  it('stops waking once the lease has run out', async function () {
    const pending: Array<() => void> = []

    const clock: Clock = {
      now: () => Date.now(),
      setTimeout: (fn: () => void) => { pending.push(fn); return pending.length },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {}
    }

    const tk = makeTk(clock)

    ;(tk as any).secondCronCache = [row('* * * * * *')]
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND
    ;(tk as any).scheduleSecondTick()

    // While the lease lasts, each tick arms the next.
    await pending.shift()!()
    await until(async () => pending.length === 1)

    // Once it has run out, the tick evaluates nothing and arms nothing, so an instance that has
    // lost the claim does not wake every second.
    ;(tk as any).leaseUntil = Date.now()
    await pending.shift()!()
    await delay(50)

    expect(pending).toHaveLength(0)
  })

  it('does not tick for an instance whose schedules all stay with the pass', async function () {
    const tk = makeTk()

    const claim = plans.trySetCronTime('test', 30)
    const executeSql = tk.db.executeSql
    tk.db.executeSql = async (sql: string, params?: unknown[]) => sql === claim
      ? { rows: [{ claimed: true, priorCronOn: null }] }
      : await executeSql(sql, params)

    ;(tk as any).getSchedules = async () => [row('* * * * *'), row('0 * * * * *', { name: 'zero' })]

    await tk.onCron()

    expect((tk as any).secondTickTimer).toBeFalsy()

    ;(tk as any).getSchedules = async () => [row('* * * * *'), row('* * * * * *', { name: 'every' })]

    await tk.onCron()

    expect((tk as any).secondTickTimer).toBeTruthy()

    await tk.stop()
  })

  it('waits on stop for a per-second evaluation that is still running, and does not start a second one beside it', async function () {
    const tk = makeTk()

    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })

    let inserts = 0
    tk.manager.insert = async () => { inserts++; await held; return null }

    ;(tk as any).secondCronCache = [row('* * * * * *')]
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    const evaluation = tk.onSecond()

    // A tick that lands while the one before it is still running does nothing.
    await tk.onSecond()
    expect(inserts).toBe(1)

    let stopped = false
    const stopping = tk.stop().then(() => { stopped = true })

    try {
      await delay(100)
      expect(stopped).toBe(false)
    } finally {
      release()
    }

    await Promise.all([evaluation, stopping])
    expect(stopped).toBe(true)
  })

  it('releases the pending per-second tick on stop', async function () {
    const armed = new Set<ClockTimer>()

    const clock: Clock = {
      now: () => Date.now(),
      setTimeout: (fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms)
        armed.add(handle)
        return handle
      },
      clearTimeout: (handle: ClockTimer) => {
        armed.delete(handle)
        clearTimeout(handle as NodeJS.Timeout)
      },
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: ClockTimer) => clearInterval(handle as NodeJS.Timeout)
    }

    const tk = makeTk(clock)

    ;(tk as any).secondCronCache = [row('* * * * * *')]
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND
    ;(tk as any).scheduleSecondTick()

    // Arming again while one is pending keeps the one chain.
    ;(tk as any).scheduleSecondTick()
    expect(armed.size).toBe(1)

    await tk.stop()

    expect(armed.size).toBe(0)
  })
})

// Real-time wait for I/O a tick started; tick itself never waits on I/O.
async function until (predicate: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('until: condition not met')
    await delay(10)
  }
}

/** When an instance last claimed a pass, off the version row. */
async function lastPass (boss: PgBoss): Promise<number> {
  const { rows } = await boss.getDb().executeSql(`SELECT cron_on FROM ${ctx.schema}.version`)

  return new Date(rows[0].cron_on).getTime()
}

/** The throttle slots the send-it queue holds for a queue, oldest first, as epoch milliseconds. */
async function slotsFiled (boss: PgBoss, name: string): Promise<number[]> {
  const { rows } = await boss.getDb().executeSql(
    `SELECT to_char(singleton_on, 'YYYY-MM-DD"T"HH24:MI:SS') AS slot FROM ${ctx.schema}.job WHERE name = $1 AND data->>'name' = $2 ORDER BY singleton_on`,
    [QUEUES.SEND_IT, name]
  )

  return rows.map(row => Date.parse(row.slot + 'Z'))
}

/** Advances a second at a time, which is how often the claim holder evaluates. */
async function stepTo (clock: TestClock, to: number) {
  while (clock.now() < to) {
    await clock.tick(Math.min(SECOND, to - clock.now()))
  }
}

function every (after: number, until: number, step: number): number[] {
  const out: number[] = []

  for (let t = Math.floor(after / step) * step + step; t <= until; t += step) out.push(t)

  return out
}

// Each test walks the clock a second at a time for minutes, a database round trip per second. A
// couple of seconds on an idle machine; raised for the block as scheduleSlotTest does, lifting only.
const blockTimeout = isDistributedBackend ? distributedTimeout : 60000

describe('schedule seconds on the database', { timeout: blockTimeout }, function () {
  const T0 = Date.parse('2026-01-01T12:00:00Z')

  it('sends each occurrence once while one instance holds the claim', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: true })

    // The pass start() runs before anything below stamps the version row off the test clock.
    await until(async () => await lastPass(ctx.boss!) === T0)

    await ctx.boss.createQueue('every5')
    await ctx.boss.createQueue('minute')
    await ctx.boss.schedule('every5', '*/5 * * * * *')
    await ctx.boss.schedule('minute', '0 * * * * *')

    await stepTo(clock, T0 + 150 * SECOND)

    // Every fifth second since the schedule was stored, each once. The expression whose seconds
    // field is only 0 is filed by the minute as it always was, which includes the occurrence on the
    // instant it was stored: the pass sends the newest occurrence in the window.
    expect(await slotsFiled(ctx.boss, 'every5')).toEqual(every(T0, T0 + 150 * SECOND, 5 * SECOND))
    expect(await slotsFiled(ctx.boss, 'minute')).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE])
  })

  it('sends each occurrence once across two instances when the one holding the claim stops', async function () {
    const clock = new TestClock(T0)
    const x = await helper.start({ ...ctx.bossConfig, clock, schedule: true })
    ctx.boss = x

    await until(async () => await lastPass(x) === T0)

    const y = await helper.start({ ...ctx.bossConfig, clock, schedule: true, noDefault: true })

    try {
      await x.createQueue('every')
      await x.schedule('every', '* * * * * *')

      // X holds the claim. It stops partway through a lease, and Y takes the claim once the row
      // comes due, reading on from where X's lease began.
      await stepTo(clock, T0 + 45 * SECOND)
      await x.stop({ graceful: false })

      await stepTo(clock, T0 + 150 * SECOND)

      expect(await slotsFiled(y, 'every')).toEqual(every(T0, T0 + 150 * SECOND, SECOND))
    } finally {
      await y.stop({ graceful: false })
    }
  })
})
