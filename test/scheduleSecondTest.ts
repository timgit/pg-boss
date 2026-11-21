import { expect } from 'vitest'
import pg from 'pg'
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

  // Each schedule's cursor, as the cron statement would find it on the row. Unset reads as NULL.
  const cursors = new Map<string, number | null>()

  // The occurrences the cron statement inserted a job for, and every schedule it was handed.
  const sent: number[] = []
  const statements: any[][] = []

  const manager = {
    insert: async (_queue: string, jobs: any[]) => { inserted.push(...jobs) },
    offWork: async () => {},
    getQueueCache: async () => ({ notify: false }),
    scheduledJobFields: (name: string, data: unknown, options: object) => ({ ...options, name, data }),
    // The statement's compare-and-set, over `cursors`: a schedule claims when its cursor is behind
    // `through`, and inserts the occurrences after the cursor it replaced.
    sendScheduled: async (_count: number, build: (traceContext: null) => { values: unknown[] }) => {
      const { values } = build(null)
      const payload = JSON.parse(values[0] as string)
      const jobs = JSON.parse(values[1] as string)
      const rows: any[] = []

      statements.push(payload)

      for (const schedule of payload) {
        const id = JSON.stringify([schedule.name, schedule.key])
        const prev = cursors.get(id) ?? null
        const through = Date.parse(schedule.through)
        const claimed = prev === null || prev < through

        rows.push({ name: schedule.name, key: schedule.key, prev: prev === null ? null : new Date(prev), claimed, id: null })

        if (!claimed) continue

        cursors.set(id, through)

        for (const job of jobs.filter((job: any) => job.name === schedule.name && job.scheduleKey === schedule.key)) {
          const occurrence = Date.parse(job.occurrence)

          if (prev === null || occurrence > prev) {
            sent.push(occurrence)
            rows.push({ name: schedule.name, id: job.id })
          }
        }
      }

      return rows
    }
  }

  const tk = new Timekeeper(db as any, manager as any, { schema: 'test', clock, cronMonitorIntervalSeconds: 30 } as any)

  ;(tk as any).stopped = false

  return Object.assign(tk, { executed, inserted, cursors, sent, statements })
}

/** Caches rows for the per-second tick as a won claim does, and answers with the cache. */
async function cache (tk: ReturnType<typeof makeTk>, rows: unknown[]) {
  await (tk as any).cacheSecondSchedules(rows)

  return (tk as any).secondCronCache
}

/** One schedule row asking for per-second precision, as getSchedules() hands it to the pass. */
function row (cron: string, extra: Record<string, unknown> = {}) {
  return { name: 'q', key: '', data: null, options: { precision: 'second' }, kind: plans.SCHEDULE_KINDS.cron, cron, timezone: 'UTC', ...extra }
}

/**
 * A pass at `databaseTime` after the one at `priorCronOn`, answering with the slots it filed through
 * send-it, then the second of each occurrence the cron statement sent a job for. A schedule whose
 * cursor is unset starts at the last pass, which is as far as the pass before this one sent.
 */
async function pass (tk: ReturnType<typeof makeTk>, databaseTime: number, priorCronOn: number | null, schedules: any[]) {
  const before = tk.inserted.length
  const sentBefore = tk.sent.length

  for (const schedule of schedules) {
    const id = JSON.stringify([schedule.name, schedule.key])

    if (!tk.cursors.has(id)) tk.cursors.set(id, priorCronOn)
  }

  tk.clockSkew = databaseTime - tk.config.clock.now()

  await tk.cron(priorCronOn === null ? null : new Date(priorCronOn), schedules as any)

  return [
    ...tk.inserted.slice(before).map(job => job.__singletonSlot),
    ...tk.sent.slice(sentBefore).map(occurrence => slotOf(occurrence))
  ]
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

  it('files a seconds field by the minute unless the schedule asks for per-second precision', async function () {
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    // The options every schedule stored before `precision` existed, and the ones naming the default.
    for (const options of [{}, { precision: 'minute' }, { precision: 'unknown' }]) {
      for (const cron of ['* * * * * *', '*/15 * * * * *', '@secondly']) {
        expect(await pass(makeTk(), now, now - 2 * SECOND, [row(cron, { options })]), `${cron} ${JSON.stringify(options)}`).toEqual([slotOf(minute, 60)])
      }
    }
  })

  it('rejects a precision no pass would honor, and reads a nullish one as none given', async function () {
    const tk = makeTk()

    await expect(tk.schedule('q', '* * * * * *', null, { precision: 'millisecond' } as any))
      .rejects.toThrow(/precision must be one of: minute, second/)
    await expect(tk.schedule('q', '* * * * * *', null, { precision: null } as any)).resolves.toBeUndefined()
    await expect(tk.schedule('q', '* * * * * *', null, { precision: 'second', singletonSeconds: 5, singletonNextSlot: true }))
      .rejects.toThrow(/singletonNextSlot is not supported/)
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

  it('does not reach back past the due window or the cursor', async function () {
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    // A cursor ten minutes old with passes running all along, as a holder whose sends failed for
    // that long leaves it: the window's 60 seconds are owed, and anything older is gone.
    const stale = makeTk()
    stale.cursors.set(JSON.stringify(['q', '']), now - 10 * MINUTE)
    expect(await pass(stale, now, now - 30 * SECOND, [row('* * * * * *')])).toEqual(secondsIn(now - MINUTE, now))

    // A schedule stored five seconds ago starts its cursor then, and owes the five seconds since.
    const created = makeTk()
    created.cursors.set(JSON.stringify(['q', '']), now - 5 * SECOND)
    expect(await pass(created, now, now - 30 * SECOND, [row('* * * * * *')])).toEqual(secondsIn(now - 5 * SECOND, now))
  })

  it('sends nothing for a gap under skip and moves the cursor to now', async function () {
    const tk = makeTk()
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30 * SECOND

    expect(await pass(tk, now, now - 10 * MINUTE, [row('* * * * * *')])).toEqual([])
    expect(tk.cursors.get(JSON.stringify(['q', '']))).toBe(now)

    // The tick after it reads on from there.
    await cache(tk, [row('* * * * * *')])
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND
    tk.clockSkew = now + 2 * SECOND - Date.now()

    await tk.onSecond()
    expect(tk.sent).toEqual([now + SECOND, now + 2 * SECOND])
  })

  it('sends the latest occurrence of a twice-daily expression for a gap ending the day the clocks skipped its time', async function () {
    // 00:30 was skipped in America/Havana on 2026-03-08, and prev() throws from any time up to the
    // next occurrence. The gap holds 12:30:30 CST on the 7th, which a read a whole day back passes.
    const now = Date.parse('2026-03-08T06:45:40Z')
    const options = { timezone: 'America/Havana', options: { precision: 'second', missed: 'once' } }

    expect(await pass(makeTk(), now, Date.parse('2026-03-07T06:00:00Z'), [row('30 30 0,12 * * *', options)])).toEqual([slotOf(Date.parse('2026-03-07T17:30:30Z'))])
  })

  it('sends the latest occurrence for a gap under once, however many came due', async function () {
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30 * SECOND
    const once = { options: { precision: 'second', missed: 'once' } }

    const tk = makeTk()
    expect(await pass(tk, now, now - 10 * MINUTE, [row('* * * * * *', once)])).toEqual([slotOf(now)])

    // A sparse expression sends the one occurrence the gap held, however far back.
    const sparse = makeTk()
    const at = Math.floor((now - 5 * MINUTE) / MINUTE) * MINUTE + 15 * SECOND
    const cron = `15 ${new Date(at).getUTCMinutes()} * * * *`
    expect(await pass(sparse, now, now - 10 * MINUTE, [row(cron, once)])).toEqual([slotOf(at)])

    // Nothing from before the row was stored.
    const fresh = makeTk()
    expect(await pass(fresh, now, now - 10 * MINUTE, [row(cron, { ...once, createdOn: new Date(at + SECOND) })])).toEqual([])
  })

  it('reads on from where it last sent, and sends a range again when its send failed', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    expect(await pass(tk, now, now - 3 * SECOND, [row('* * * * * *')])).toEqual(secondsIn(now - 3 * SECOND, now))

    // The next pass of the same instance owes only what came due since, whatever its claim says.
    expect(await pass(tk, now + 2 * SECOND, now - 10 * SECOND, [row('* * * * * *')])).toEqual(secondsIn(now, now + 2 * SECOND))

    // A send that fails leaves the hint where it was, so the next evaluation sends the range, and
    // the schedule is warned about once.
    const warnings: any[] = []
    tk.on('warning', warning => warnings.push(warning))

    const sendScheduled = tk.manager.sendScheduled
    tk.manager.sendScheduled = async () => { throw new Error('insert failed') }

    expect(await pass(tk, now + 4 * SECOND, now, [row('* * * * * *')])).toEqual([])
    expect(await pass(tk, now + 4 * SECOND, now, [row('* * * * * *')])).toEqual([])
    expect(warnings.map(warning => warning.message)).toEqual(['Warning: schedule for queue "q" (key "") could not be sent: insert failed'])

    tk.manager.sendScheduled = sendScheduled

    expect(await pass(tk, now + 5 * SECOND, now, [row('* * * * * *')])).toEqual(secondsIn(now + 2 * SECOND, now + 5 * SECOND))
  })

  it('skips and warns about a row whose occurrences cannot be read, and sends the others', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    const warnings: any[] = []
    tk.on('warning', warning => warnings.push(warning))

    const secondSend = (tk as any).secondSend.bind(tk)
    ;(tk as any).secondSend = (entry: any, ...rest: unknown[]) => {
      if (entry.schedule.name === 'broken') throw new Error('unreadable')

      return secondSend(entry, ...rest)
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

    await cache(tk, [row('* * * * * *'), row('* * * * * *', { name: 'broken' })])
    tk.cursors.set(JSON.stringify(['q', '']), now - 2 * SECOND)
    ;(tk as any).secondCronHint = new Map([[JSON.stringify(['q', '']), now - 2 * SECOND]])
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    // A row whose read fails is passed over without failing the others: the pass that cached it
    // read it the same way and warned.
    const secondSend = (tk as any).secondSend.bind(tk)
    ;(tk as any).secondSend = (entry: any, ...rest: unknown[]) => {
      if (entry.schedule.name === 'broken') throw new Error('unreadable')

      return secondSend(entry, ...rest)
    }

    await tk.onSecond()
    expect(tk.sent).toEqual([now - SECOND, now])

    // The next tick reads on from there, so within the same second it owes nothing, and sends no
    // statement.
    await tk.onSecond()
    expect(tk.statements).toHaveLength(1)

    ;(tk as any).leaseUntil = Date.now()

    await tk.onSecond()
    expect(tk.statements).toHaveLength(1)
  })

  it('sends a range again after a failed per-second send', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30 * SECOND

    tk.clockSkew = now - Date.now()

    await cache(tk, [row('* * * * * *')])
    tk.cursors.set(JSON.stringify(['q', '']), now - SECOND)
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    const sendScheduled = tk.manager.sendScheduled
    tk.manager.sendScheduled = async () => { throw new Error('insert failed') }

    await tk.onSecond()
    expect(tk.sent).toEqual([])

    tk.manager.sendScheduled = sendScheduled

    await tk.onSecond()
    expect(tk.sent).toEqual([now])
  })

  it('warns about a schedule on a key_strict_fifo queue without a singletonKey, as send() refuses it', async function () {
    const tk = makeTk()
    const warnings: any[] = []
    tk.on('warning', warning => warnings.push(warning))

    tk.manager.getQueueCache = async () => ({ notify: false, policy: plans.QUEUE_POLICIES.key_strict_fifo }) as any

    await cache(tk, [row('* * * * * *')])

    expect((tk as any).secondCronCache).toEqual([])
    expect(warnings.map(warning => warning.message)).toEqual([expect.stringMatching(/key_strict_fifo queues require a singletonKey/)])
  })

  it('sends each schedule of a chunk again after a lost race on CockroachDB', async function () {
    const tk = makeTk()
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30 * SECOND

    tk.clockSkew = now - Date.now()

    await cache(tk, [row('* * * * * *'), row('* * * * * *', { name: 'other' })])
    tk.cursors.set(JSON.stringify(['q', '']), now - SECOND)
    tk.cursors.set(JSON.stringify(['other', '']), now - SECOND)
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    const sendScheduled = tk.manager.sendScheduled
    let calls = 0
    tk.manager.sendScheduled = async (count: number, build: any) => {
      if (calls++ === 0) throw Object.assign(new Error('restart transaction'), { code: '40001' })

      return await sendScheduled(count, build)
    }

    await tk.onSecond()

    expect(tk.sent).toEqual([now, now])
    expect(calls).toBe(3)
  })

  it('reports a failed last job id write without sending the chunk again', async function () {
    const tk = makeTk()
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30 * SECOND

    tk.clockSkew = now - Date.now()

    await cache(tk, [row('* * * * * *')])
    tk.cursors.set(JSON.stringify(['q', '']), now - SECOND)
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    const executeSql = tk.db.executeSql
    tk.db.executeSql = async (sql: string, params?: unknown[]) => {
      if (sql === plans.setScheduleLastJobIds('test')) throw new Error('update failed')

      return await executeSql(sql, params)
    }

    const errors: any[] = []
    tk.on('error', err => errors.push(err))

    await tk.onSecond()

    expect(tk.statements).toHaveLength(1)
    expect(tk.sent).toEqual([now])
    expect(errors.map(err => err.message)).toEqual([expect.stringMatching(/last job id could not be recorded for "q" \(key ""\): update failed/)])
  })

  it('drops a schedule changed or removed since the lease read it, and sends the others', async function () {
    const tk = makeTk()
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30 * SECOND

    tk.clockSkew = now - Date.now()

    await cache(tk, [row('* * * * * *'), row('* * * * * *', { name: 'gone' })])
    tk.cursors.set(JSON.stringify(['q', '']), now - SECOND)
    tk.cursors.set(JSON.stringify(['gone', '']), now - SECOND)
    ;(tk as any).leaseUntil = Date.now() + 10 * SECOND

    // The statement matches no row for a definition that is no longer in the table.
    const sendScheduled = tk.manager.sendScheduled
    tk.manager.sendScheduled = async (count: number, build: any) => {
      const rows = await sendScheduled(count, build)

      return rows.filter((row: any) => row.name !== 'gone')
    }

    await tk.onSecond()
    expect((tk as any).secondCronCache.map((entry: any) => entry.schedule.name)).toEqual(['q'])
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

    await cache(tk, [row('* * * * * *')])
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

  it('times the lease from the stamp the claim wrote, and arms the tick when the pass throws after reading', async function () {
    const tk = makeTk()
    const claim = plans.trySetCronTime('test', 30)
    const claimedOn = Date.now() - 5 * SECOND

    const executeSql = tk.db.executeSql
    tk.db.executeSql = async (sql: string, params?: unknown[]) => sql === claim
      ? { rows: [{ claimed: true, priorCronOn: null, claimedOn: new Date(claimedOn) }] }
      : await executeSql(sql, params)

    ;(tk as any).getSchedules = async () => [row('* * * * * *')]
    tk.cron = async () => { await (tk as any).cacheSecondSchedules([row('* * * * * *')]); throw new Error('relabel failed') }

    const errors: any[] = []
    tk.on('error', err => errors.push(err))

    await tk.onCron()

    expect((tk as any).leaseUntil).toBe(claimedOn + 30 * SECOND)
    expect(errors.map(err => err.message)).toEqual(['relabel failed'])
    expect((tk as any).secondTickTimer).toBeTruthy()

    await tk.stop()
  })

  it('waits on stop for a per-second evaluation that is still running, and does not start a second one beside it', async function () {
    const tk = makeTk()

    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })

    let inserts = 0
    tk.manager.sendScheduled = async () => { inserts++; await held; return [] }

    await cache(tk, [row('* * * * * *')])
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

  it('counts a range from the first whole second after it opens', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE

    expect(await pass(tk, minute + 3500, minute + 1500, [row('* * * * * *')])).toEqual([slotOf(minute + 2 * SECOND), slotOf(minute + 3 * SECOND)])
  })

  // The day after the clocks skip a time an expression names, the occurrence before the first one
  // of the day does not exist, and cron-parser's prev() throws when asked for it.
  const afterSkippedTime: Array<[string, string, number, number[]]> = [
    // 00:30 was skipped on 2026-03-08.
    ['America/Havana', '30 30 0 * * *', Date.parse('2026-03-09T04:30:40Z'), [Date.parse('2026-03-09T04:30:30Z')]],
    ['America/Havana', '*/10 30 0 * * *', Date.parse('2026-03-09T04:30:15Z'), [Date.parse('2026-03-09T04:30:00Z'), Date.parse('2026-03-09T04:30:10Z')]],
    // 02:15 was skipped on 2026-10-04, half an hour rather than an hour.
    ['Australia/Lord_Howe', '30 15 2 * * *', Date.parse('2026-10-04T15:15:40Z'), [Date.parse('2026-10-04T15:15:30Z')]]
  ]

  for (const [timezone, cron, now, occurrences] of afterSkippedTime) {
    it(`sends ${cron} in ${timezone} the day after the clocks skipped its time, from a pass and from a tick`, async function () {
      const warnings: any[] = []

      const tk = makeTk()
      tk.on('warning', warning => warnings.push(warning))

      expect(await pass(tk, now, now - 30 * SECOND, [row(cron, { timezone })])).toEqual(occurrences.map(occurrence => slotOf(occurrence)))
      expect(warnings).toEqual([])

      const ticking = makeTk()

      ticking.clockSkew = now - Date.now()

      await cache(ticking, [row(cron, { timezone })])
      ticking.cursors.set(JSON.stringify(['q', '']), now - 30 * SECOND)
      ;(ticking as any).leaseUntil = Date.now() + 10 * SECOND

      await ticking.onSecond()

      expect(ticking.sent).toEqual(occurrences)
    })
  }

  it('does not warn about a schedule on the day the clocks skip the time it names', async function () {
    const warnings: any[] = []

    const tk = makeTk()
    tk.on('warning', warning => warnings.push(warning))

    const now = Date.parse('2026-03-08T12:00:00Z')

    expect(await pass(tk, now, now - 30 * SECOND, [row('30 30 0 * * *', { timezone: 'America/Havana' })])).toEqual([])
    expect(warnings).toEqual([])
  })

  it('skips and warns about a row whose time zone cannot be read', async function () {
    const warnings: any[] = []

    const tk = makeTk()
    tk.on('warning', warning => warnings.push(warning))

    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30 * SECOND

    expect(await pass(tk, now, now - SECOND, [row('* * * * * *', { name: 'broken', timezone: 'Not/AZone' }), row('* * * * * *')])).toEqual([slotOf(now)])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/schedule for queue "broken" \(key ""\) could not be evaluated and was skipped/)
  })

  it('sends a repeated local time once unless the expression keeps running through that hour', async function () {
    const zone = { timezone: 'America/New_York' }
    const first = Date.parse('2026-11-01T05:30:25Z')
    const second = first + 60 * MINUTE

    const sentAt = async (cron: string, now: number, options = zone) => (await pass(makeTk(), now, now - 30 * SECOND, [row(cron, options)])).length

    expect(await sentAt('*/10 30 1 * * *', first)).toBe(3)
    expect(await sentAt('*/10 30 1 * * *', second)).toBe(0)

    expect(await sentAt('*/10 30 * * * *', first)).toBe(3)
    expect(await sentAt('*/10 30 * * * *', second)).toBe(3)

    // Multiple minutes across multiple hours make a run, which keeps sending through the repeated hour.
    expect(await sentAt('*/10 * 0-6 * * *', first)).toBe(3)
    expect(await sentAt('*/10 * 0-6 * * *', second)).toBe(3)

    // 01:45 comes round twice half an hour apart in a zone that goes back by half an hour.
    const lordHowe = { timezone: 'Australia/Lord_Howe' }

    expect(await sentAt('30 45 1 * * *', Date.parse('2026-04-04T14:45:40Z'), lordHowe)).toBe(1)
    expect(await sentAt('30 45 1 * * *', Date.parse('2026-04-04T15:15:40Z'), lordHowe)).toBe(0)
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

    await cache(tk, [row('* * * * * *')])
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

/**
 * What a schedule sent every second has sent: its queue's job count, the cursor it left, and how
 * many send-it jobs it went through, which is none.
 */
async function sentFor (boss: PgBoss, name: string): Promise<{ jobs: number, sentOn: number, sendIt: number }> {
  const { rows } = await boss.getDb().executeSql(
    `SELECT (SELECT count(*) FROM ${ctx.schema}.job WHERE name = $1)::int AS jobs,
      (SELECT sent_on FROM ${ctx.schema}.schedule WHERE name = $1) AS sent_on,
      (SELECT count(*) FROM ${ctx.schema}.job WHERE name = $2 AND data->>'name' = $1)::int AS send_it`,
    [name, QUEUES.SEND_IT]
  )

  return { jobs: Number(rows[0].jobs), sentOn: new Date(rows[0].sent_on).getTime(), sendIt: Number(rows[0].send_it) }
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
    await ctx.boss.createQueue('unprecise')
    await ctx.boss.schedule('every5', '*/5 * * * * *', null, { precision: 'second' })
    await ctx.boss.schedule('minute', '0 * * * * *', null, { precision: 'second' })
    await ctx.boss.schedule('unprecise', '* * * * * *')

    await stepTo(clock, T0 + 152 * SECOND)

    // Every fifth second since the schedule was stored, each once, sent without the send-it queue.
    // The cursor holds the last occurrence sent, not the time it was sent.
    // The expression whose seconds field is only 0 is filed by the minute as it always was, which
    // includes the occurrence on the instant it was stored: the pass sends the newest occurrence in
    // the window.
    const fives = every(T0, T0 + 150 * SECOND, 5 * SECOND)
    expect(await sentFor(ctx.boss, 'every5')).toEqual({ jobs: fives.length, sentOn: fives[fives.length - 1], sendIt: 0 })
    expect(await slotsFiled(ctx.boss, 'minute')).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE])

    // Without `precision: 'second'`, a seconds field sends a job a minute, as every release before
    // per-second schedules did.
    expect(await slotsFiled(ctx.boss, 'unprecise')).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE])
  })

  it('starts the cursor when a definition is stored or changed, and keeps it otherwise', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: false })

    const sentOn = async () => {
      const { rows } = await ctx.boss!.getDb().executeSql(`SELECT sent_on FROM ${ctx.schema}.schedule WHERE name = 'q'`)

      return new Date(rows[0].sent_on).getTime()
    }

    await ctx.boss.createQueue('q')
    await ctx.boss.schedule('q', '* * * * * *')
    expect(await sentOn()).toBe(T0)

    // New data, or the same definition stored again on a boot, keeps the cursor where it is.
    await clock.setTime(T0 + MINUTE)
    await ctx.boss.schedule('q', '* * * * * *', { new: 'data' })
    await ctx.boss.schedule('q', '* * * * * *', null, { precision: 'minute' })
    expect(await sentOn()).toBe(T0)

    // Opting in is a new definition, which owes nothing from before it.
    await ctx.boss.schedule('q', '* * * * * *', null, { precision: 'second' })
    expect(await sentOn()).toBe(T0 + MINUTE)

    await clock.setTime(T0 + 2 * MINUTE)
    await ctx.boss.schedule('q', '*/5 * * * * *', null, { precision: 'second' })
    expect(await sentOn()).toBe(T0 + 2 * MINUTE)

    await clock.setTime(T0 + 3 * MINUTE)
    await ctx.boss.schedule('q', '*/5 * * * * *', null, { precision: 'second', tz: 'Europe/Paris' })
    expect(await sentOn()).toBe(T0 + 3 * MINUTE)
  })

  it('sends nothing after an unschedule, and the new definition after an edit, from the next tick', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: true })

    await until(async () => await lastPass(ctx.boss!) === T0)

    await ctx.boss.createQueue('removed')
    await ctx.boss.createQueue('edited')
    await ctx.boss.schedule('removed', '* * * * * *', null, { precision: 'second' })
    await ctx.boss.schedule('edited', '* * * * * *', { version: 1 }, { precision: 'second' })

    // Read at the next check, which sends what came due since they were stored.
    await stepTo(clock, T0 + 40 * SECOND)

    const removed = (await sentFor(ctx.boss, 'removed')).jobs
    expect(removed).toBe(40)

    await ctx.boss.unschedule('removed')
    await ctx.boss.schedule('edited', '* * * * * *', { version: 2 }, { precision: 'second' })

    await stepTo(clock, T0 + 45 * SECOND)

    expect((await sentFor(ctx.boss, 'removed')).jobs).toBe(removed)

    // A data change keeps the cursor, so the edit costs no occurrence.
    const { rows } = await ctx.boss.getDb().executeSql(
      `SELECT data->>'version' AS version, count(*)::int AS jobs FROM ${ctx.schema}.job WHERE name = 'edited' GROUP BY 1 ORDER BY 1`
    )
    expect(rows.map(row => [row.version, Number(row.jobs)])).toEqual([['1', 40], ['2', 5]])
  })

  it('sends one job for an outage under once and none under skip, then resumes', async function () {
    const clock = new TestClock(T0)
    const x = await helper.start({ ...ctx.bossConfig, clock, schedule: true })
    ctx.boss = x

    await until(async () => await lastPass(x) === T0)

    await x.createQueue('once')
    await x.createQueue('skip')
    await x.schedule('once', '* * * * * *', null, { precision: 'second', missed: 'once' })
    await x.schedule('skip', '* * * * * *', null, { precision: 'second' })

    await stepTo(clock, T0 + 40 * SECOND)
    await x.stop({ graceful: false })

    const restart = T0 + 10 * MINUTE
    await clock.setTime(restart)

    const y = await helper.start({ ...ctx.bossConfig, clock, schedule: true, noDefault: true })

    try {
      await until(async () => await lastPass(y) === restart)
      await until(async () => (await sentFor(y, 'once')).jobs === 41)

      expect(await sentFor(y, 'once')).toEqual({ jobs: 41, sentOn: restart, sendIt: 0 })
      expect(await sentFor(y, 'skip')).toEqual({ jobs: 40, sentOn: restart, sendIt: 0 })

      await stepTo(clock, restart + 3 * SECOND)

      expect((await sentFor(y, 'once')).jobs).toBe(44)
      expect((await sentFor(y, 'skip')).jobs).toBe(43)
    } finally {
      await y.stop({ graceful: false })
    }
  })

  // Two connections, so one statement can hold the row lock while the other waits on it.
  it.skipIf(helper.isPglite || helper.isCockroachDb)('lets one of two statements racing on a schedule send its occurrences', async function () {
    const clock = new TestClock(T0)
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: false })

    await ctx.boss.createQueue('q')
    await ctx.boss.schedule('q', '* * * * * *', null, { precision: 'second' })

    const [schedule] = await ctx.boss.getSchedules('q')
    const sql = plans.sendScheduledJobs(ctx.schema)

    const payload = (through: number) => [
      JSON.stringify([{
        name: 'q',
        key: '',
        cron: schedule.cron,
        timezone: schedule.timezone,
        data: null,
        options: schedule.options,
        through: new Date(T0 + through * SECOND).toISOString()
      }]),
      JSON.stringify(Array.from({ length: through }, (_, i) => ({ id: crypto.randomUUID(), name: 'q', scheduleKey: '', occurrence: new Date(T0 + (i + 1) * SECOND).toISOString() })))
    ]

    const first = new pg.Client({ connectionString: helper.getConnectionString() })
    const second = new pg.Client({ connectionString: helper.getConnectionString() })

    await first.connect()
    await second.connect()

    try {
      await first.query('BEGIN')
      await first.query(sql, payload(3))

      let settled = false
      const racing = second.query(sql, payload(5)).then(result => { settled = true; return result })

      await delay(200)
      expect(settled).toBe(false)

      await first.query('COMMIT')

      const { rows } = await racing

      expect(rows.filter(row => row.id === null)).toEqual([expect.objectContaining({ name: 'q', claimed: false })])
      expect(await sentFor(ctx.boss, 'q')).toEqual({ jobs: 3, sentOn: T0 + 3 * SECOND, sendIt: 0 })
    } finally {
      await first.end()
      await second.end()
    }
  })

  it('sends each occurrence once across two instances when the one holding the claim stops', async function () {
    const clock = new TestClock(T0)
    const x = await helper.start({ ...ctx.bossConfig, clock, schedule: true })
    ctx.boss = x

    await until(async () => await lastPass(x) === T0)

    const y = await helper.start({ ...ctx.bossConfig, clock, schedule: true, noDefault: true })

    try {
      await x.createQueue('every')
      await x.schedule('every', '* * * * * *', null, { precision: 'second' })

      // X holds the claim. It stops partway through a lease, and Y takes the claim once the row
      // comes due, reading on from where X's lease began.
      await stepTo(clock, T0 + 45 * SECOND)
      await x.stop({ graceful: false })

      await stepTo(clock, T0 + 150 * SECOND)

      expect(await sentFor(y, 'every')).toEqual({ jobs: 150, sentOn: T0 + 150 * SECOND, sendIt: 0 })
    } finally {
      await y.stop({ graceful: false })
    }
  })
})
