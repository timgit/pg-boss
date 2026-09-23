import { expect } from 'vitest'
import { delay } from '../src/tools.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import Timekeeper from '../src/timekeeper.ts'
import { systemClock } from '../src/clock.ts'
import { PgBoss } from '../src/index.ts'
import type { Job } from '../src/types.ts'
import { ctx } from './hooks.ts'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

// A daily schedule, so a gap holds a countable number of occurrences and the due window holds none:
// every job a test sees is one the catch-up sent.
const DAILY = '0 3 * * *'

/**
 * A Timekeeper over a database that answers the clock query and records every statement, which is
 * all a pass needs: occurrences are pure arithmetic on (expression, clock, zone), and the writes a
 * pass makes are the relabel and the warning insert.
 */
function makeTk () {
  const executed: Array<{ sql: string, params: unknown[] }> = []

  const db = {
    executeSql: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params })

      return { rows: [{ time: String(Date.now()) }] }
    }
  }

  const tk = new Timekeeper(db as any, {} as any, { schema: 'test', clock: systemClock } as any)

  return Object.assign(tk, { executed })
}

/** The 60-second throttle slot a forwarded job lands in, as the insert files it: UTC, zoneless. */
function slotOf (epochMs: number) {
  return new Date(Math.floor(epochMs / MINUTE) * MINUTE).toISOString().replace('T', ' ').slice(0, 19)
}

/** The iCalendar spelling of an instant, for a DTSTART built around the clock. */
function ical (epochMs: number) {
  return new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * A pass over `schedules` with the database clock at `databaseTime` and the last pass at
 * `priorCronOn`, answering with the jobs it forwarded.
 */
async function pass (tk: ReturnType<typeof makeTk>, databaseTime: number, priorCronOn: unknown, schedules: unknown[]) {
  const inserted: any[] = []

  ;(tk as any).stopped = false
  ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }
  ;(tk as any).getSchedules = async () => schedules

  tk.clockSkew = databaseTime - Date.now()

  await tk.cron(priorCronOn)

  return inserted
}

/** One schedule row, as getSchedules() hands it to the pass. */
function row (cron: string, missed?: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'q',
    key: '',
    data: null,
    options: missed === undefined ? {} : { missed },
    kind: plans.SCHEDULE_KINDS.cron,
    cron,
    timezone: 'UTC',
    ...extra
  }
}

/** The slots a pass filed jobs in, a catch-up occurrence's before the due one's. */
function slots (inserted: any[]) {
  return inserted.map(job => job.__singletonSlot)
}

async function waitForJobs (boss: PgBoss, count: number): Promise<Job[]> {
  const jobs: Job[] = []
  const deadline = Date.now() + 8_000

  while (Date.now() < deadline) {
    jobs.push(...await boss.fetch<object>(ctx.schema, { batchSize: 100 }))

    if (jobs.length >= count) {
      break
    }

    await delay(100)
  }

  return jobs
}

function firingConfig () {
  return {
    ...ctx.bossConfig,
    cronMonitorIntervalSeconds: 1,
    cronWorkerIntervalSeconds: 1,
    schedule: true
  }
}

/**
 * Backdates the version row's cron pass timestamp and the schedule's own creation, which is a
 * deployment that has been down since `gapStart` with a schedule older than the outage.
 */
async function openGap (gapStart: Date) {
  const db = await helper.getDb()

  try {
    await db.executeSql(`UPDATE ${ctx.schema}.schedule SET created_on = $1`, [new Date(gapStart.getTime() - DAY).toISOString()])
    await db.executeSql(`UPDATE ${ctx.schema}.version SET cron_on = $1`, [gapStart.toISOString()])
  } finally {
    await db.close()
  }
}

describe('schedule missed', function () {
  it('sends nothing for a gap by default', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    // Ten minutes of a per-minute schedule went by with no pass, and the default policy is that a
    // pass sends the due window and nothing else, which is what every release before it did.
    const inserted = await pass(tk, now, new Date(now - 10 * MINUTE), [row('* * * * *')])

    expect(slots(inserted)).toEqual([slotOf(minute)])
  })

  it('sends one job for the whole gap under once', async function () {
    const tk = makeTk()

    // A pass mid-minute, so the occurrences the gap holds are the minute boundaries behind it.
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    const inserted = await pass(tk, now, new Date(now - 10 * MINUTE), [row('* * * * *', 'once')])

    // The most recent one, which for a schedule whose job reads the current state of the world is
    // the only one worth running, and then the occurrence in the due window.
    expect(slots(inserted)).toEqual([slotOf(minute - MINUTE), slotOf(minute)])
  })

  it('reads a recurrence rule backwards over the gap', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    const inserted = await pass(tk, now, new Date(now - 3 * MINUTE), [
      row('FREQ=MINUTELY', 'once', { kind: plans.SCHEDULE_KINDS.rrule })
    ])

    // Both formats catch up on the same range: the newest occurrence the gap held, then the due
    // one, which a rule files in its own slot rather than the insert's.
    expect(slots(inserted)).toEqual([
      slotOf(minute - MINUTE),
      slotOf(minute)
    ])
  })

  it('catches up on a rule carrying an RDATE', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    // A calendar export pairs a rule with one-off dates, and an RDATE is an absolute instant rather
    // than a phase of the rule: read backwards through rrule-temporal's previous() the walk jumps
    // to the RDATE and resumes from there, which answers with the RDATE in place of the occurrence
    // that follows it. Read through between(), the catch-up sees what the due window sees.
    const cron = [
      `DTSTART:${ical(minute - 10 * MINUTE)}`,
      'RRULE:FREQ=MINUTELY',
      `RDATE:${ical(minute - 3 * MINUTE + 12_000)}`
    ].join('\n')

    const inserted = await pass(tk, now, new Date(now - 5 * MINUTE), [
      row(cron, 'once', { kind: plans.SCHEDULE_KINDS.rrule })
    ])

    // The last minute the gap held rather than the RDATE two minutes behind it, and the due one.
    expect(slots(inserted)).toEqual([
      slotOf(minute - MINUTE),
      slotOf(minute)
    ])
  })

  it('catches up on a rule that stopped recurring partway through the gap', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    // The backwards read widens its steps to reach a sparse expression over a long gap, and a rule
    // that is empty near the window and dense behind it defeats that guess: the steps over the
    // empty stretch grow until one spans more occurrences than rrule-temporal generates in a single
    // call, and it throws rather than truncating. A per-second rule whose UNTIL passed three days
    // before the gap opened is that shape, and the whole catch-up was lost to the warning.
    const cron = [
      `DTSTART:${ical(minute - 400 * DAY)}`,
      `RRULE:FREQ=SECONDLY;UNTIL=${ical(minute - 3 * DAY)}`
    ].join('\n')

    const warnings: any[] = []
    tk.on('warning', warning => warnings.push(warning))

    const inserted = await pass(tk, now, new Date(now - 30 * DAY), [
      row(cron, 'once', { kind: plans.SCHEDULE_KINDS.rrule, createdOn: new Date(minute - 400 * DAY) })
    ])

    expect(warnings).toEqual([])
    expect(slots(inserted)).toEqual([slotOf(minute - 3 * DAY)])
  })

  it('sends nothing when the last pass is inside the due window', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    // The steady state: a pass claims cronMonitorIntervalSeconds after the one before it, plus the
    // round trip and, when the instance that ran it has stopped, the beat a refused instance waits
    // past the due moment - 46 and change at the 45-second ceiling. The window is 60 wide, so there
    // is never a gap between two passes to catch up on and the policy costs nothing: the due
    // occurrence, and nothing behind it.
    for (const seconds of [1, 30, 45, 60]) {
      const inserted = await pass(tk, now, new Date(now - seconds * 1000), [row('* * * * * *', 'once')])

      expect(slots(inserted)).toEqual([slotOf(minute)])
    }
  })

  it('does not reach back past the moment the schedule was created', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    // A schedule written during the gap, by a process that was up while nothing ran a pass. An
    // occurrence before it is of an expression that was not in the table yet, so a daily schedule
    // two minutes old owes nothing for the ten the gap held.
    const inserted = await pass(tk, now, new Date(now - 10 * MINUTE), [
      row(DAILY, 'once', { createdOn: new Date(minute - 2 * MINUTE - 30_000) })
    ])

    expect(slots(inserted)).toEqual([])
  })

  it('reads a policy it does not recognize as skip', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    // A row written straight into the table with SQL, or by a release naming a policy this one does
    // not: the pass sends what it has always sent rather than picking a policy on the row's behalf.
    const inserted = await pass(tk, now, new Date(now - 10 * MINUTE), [row('* * * * *', 'all')])

    expect(slots(inserted)).toEqual([slotOf(minute)])
  })

  it('reads a last pass and a creation time in every shape a driver hands one back', async function () {
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000
    const lastPass = now - 10 * MINUTE

    // node-postgres parses a timestamp column into a Date, and an adapter over a backend that
    // speaks JSON hands back the string or the epoch it was sent. An application sharing its pool
    // may have installed a pg-types parser of its own, such as one returning Temporal.Instant,
    // which carries epochMilliseconds and throws from valueOf so that
    // new Date(instant) cannot be used on it. All name the same instant, so a catch-up owes the same
    // occurrence whichever one the pass is holding.
    const temporalLike = (epochMs: number) => ({
      epochMilliseconds: epochMs,
      toString: () => new Date(epochMs).toISOString(),
      valueOf () { throw new TypeError('Do not use valueOf on this timestamp') }
    })

    // The other wrappers an application parses timestamps into: no epochMilliseconds, but valueOf
    // answers with epoch milliseconds, which is how Luxon, Moment and Day.js all read.
    const wrapperLike = (epochMs: number) => ({
      toString: () => new Date(epochMs).toISOString(),
      valueOf: () => epochMs
    })

    const shapes: Array<(epochMs: number) => unknown> = [
      epochMs => new Date(epochMs),
      epochMs => new Date(epochMs).toISOString(),
      epochMs => epochMs,
      temporalLike,
      wrapperLike
    ]

    for (const shape of shapes) {
      const inserted = await pass(makeTk(), now, shape(lastPass), [
        // A created_on in the same shape, and older than the gap, so the bound it puts under the
        // read is the last pass rather than the row.
        row('* * * * *', 'once', { createdOn: shape(lastPass - DAY) })
      ])

      expect(slots(inserted)).toEqual([slotOf(minute - MINUTE), slotOf(minute)])
    }
  })

  it('reads a last pass it cannot make an instant of as no last pass at all', async function () {
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    // Neither a timestamp nor anything that parses as one: an absent column, and a column holding
    // something a pass has no reading of. No last pass means no gap, so the pass sends the due
    // window and nothing else, which is what every release before catch-up sent.
    //
    // The last shape is the one that throws on the way out rather than reading as nothing: every
    // Temporal type refuses valueOf, and the zoneless ones (PlainDateTime, what a parser for a
    // `timestamp` column hands back) carry no epochMilliseconds either, so the read has nowhere
    // left to go. It must still come back as no last pass instead of escaping the pass.
    const zonelessTemporalLike = { toString: () => '2026-09-22T17:48:00', valueOf () { throw new TypeError('Do not use valueOf on this timestamp') } }

    for (const priorCronOn of [null, undefined, 'not a timestamp', new Date('not a timestamp'), {}, zonelessTemporalLike]) {
      const inserted = await pass(makeTk(), now, priorCronOn, [row('* * * * *', 'once')])

      expect(slots(inserted)).toEqual([slotOf(minute)])
    }
  })

  it('sends the due occurrence and warns when the catch-up read fails on its own', async function () {
    const tk = makeTk()

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000

    const warnings: any[] = []
    tk.on('warning', warning => warnings.push(warning))

    // The two reads are hard to make diverge on an expression, since one that cannot be read
    // backwards is refused by the due read first and the whole row is skipped. They stay in
    // separate trys anyway, so the failure is injected on the backwards read alone: the occurrence
    // that is due now is still sent, and the gap is reported rather than retried.
    ;(tk as any).latestOccurrenceBefore = () => { throw new Error('unreadable backwards') }

    const inserted = await pass(tk, now, new Date(now - 10 * MINUTE), [row('* * * * *', 'once')])

    expect(slots(inserted)).toEqual([slotOf(minute)])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/could not be caught up on the gap since the last cron pass: unreadable backwards/)
  })

  it('files a missed occurrence and a due one that share a slot as one job', async function () {
    const tk = makeTk()

    // A pass on the half minute, so the window opens mid-slot: the occurrence on the bound is
    // missed, the one a second later is due, and both belong to the same minute.
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE
    const now = minute + 30_000
    const bound = now - MINUTE

    const cron = `DTSTART:${ical(bound)}\nRRULE:FREQ=SECONDLY;COUNT=2`

    const inserted = await pass(tk, now, new Date(now - 10 * MINUTE), [
      row(cron, 'once', { kind: plans.SCHEDULE_KINDS.rrule })
    ])

    expect(slots(inserted)).toEqual([slotOf(bound)])
  })

  it('rejects a policy no pass would honor', async function () {
    const tk = makeTk()

    await expect(tk.schedule('q', DAILY, null, { missed: 'sometimes' } as any))
      .rejects.toThrow(/missed must be one of: skip, once/)
  })

  it('reads a nullish policy as none given, the way a falsy time zone is read', async function () {
    const tk = makeTk()

    // Same shape as `tz`: a policy threaded out of a config object arrives as null rather than
    // absent, and a policy name is never falsy, so nothing a caller could have meant is read past.
    // The pass reads the row as `skip` either way.
    await expect(tk.schedule('q', DAILY, null, { missed: null } as any)).resolves.toBeUndefined()

    const now = Date.now()
    const inserted = await pass(tk, now, new Date(now - 10 * MINUTE), [row(DAILY, null as any)])

    expect(slots(inserted)).toEqual([])
  })

  it('stores the policy on the schedule and reads it back', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, DAILY, null, { missed: 'once' })

    const schedule = await ctx.boss.getSchedule(ctx.schema)

    expect(schedule!.options).toMatchObject({ missed: 'once' })
  })

  it('answers the cron claim with the timestamp it replaced', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    const db = await helper.getDb()

    try {
      // No pass has run against this schema, so there is no gap to report and nothing to catch up
      // on.
      const first = await db.executeSql(plans.trySetCronTime(ctx.schema, 30))

      expect(first.rows[0].claimed).toBe(true)
      expect(first.rows[0].priorCronOn).toBeNull()

      // A second claim inside the interval takes nothing, which is what keeps two instances from
      // running the same pass. It still answers - with how old the row it lost to is, which is what
      // the refused instance measures its next attempt from.
      const contended = await db.executeSql(plans.trySetCronTime(ctx.schema, 30))

      expect(contended.rows[0].claimed).toBe(false)
      expect(Number(contended.rows[0].elapsed)).toBeGreaterThanOrEqual(0)
      expect(Number(contended.rows[0].elapsed)).toBeLessThan(30)

      const gapStart = new Date(Date.now() - 5 * MINUTE)

      await db.executeSql(`UPDATE ${ctx.schema}.version SET cron_on = $1`, [gapStart.toISOString()])

      const claimed = await db.executeSql(plans.trySetCronTime(ctx.schema, 30))

      expect(claimed.rows[0].claimed).toBe(true)
      expect(new Date(claimed.rows[0].priorCronOn).getTime()).toBe(gapStart.getTime())
      // The age of the row the claim replaced, which is the gap it just closed.
      expect(Number(claimed.rows[0].elapsed)).toBeGreaterThanOrEqual(5 * 60)
    } finally {
      await db.close()
    }
  })

  it('sends one job for an outage under once', async function () {
    ctx.boss = await helper.start(firingConfig())

    await ctx.boss.schedule(ctx.schema, DAILY, null, { missed: 'once' })

    await openGap(new Date(Date.now() - 3 * DAY))

    const jobs = await waitForJobs(ctx.boss, 1)

    expect(jobs).toHaveLength(1)

    await delay(2_000)

    expect(await ctx.boss.fetch(ctx.schema, { batchSize: 100 })).toEqual([])
  })

  it('sends nothing for an outage by default', async function () {
    ctx.boss = await helper.start(firingConfig())

    await ctx.boss.schedule(ctx.schema, DAILY)

    await openGap(new Date(Date.now() - 3 * DAY))

    // Three days of a daily schedule, and a due window holding none of it: the pass sends nothing,
    // which is the behavior every schedule keeps unless it asks for another.
    await delay(3_000)

    expect(await ctx.boss.fetch(ctx.schema, { batchSize: 100 })).toEqual([])
  })

  it('records the later occurrence of a catch-up pair as the last job', async function () {
    const tk = makeTk()

    const sent: string[] = []

    ;(tk as any).manager = {
      send: async () => {
        const id = `job-${sent.length}`

        sent.push(id)

        return id
      }
    }

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE

    // A catch-up occurrence and the one due now, which a pass creates in a single insert, so they
    // share a created_on and come back from the fetch in an order nothing promises. The due job
    // names no slot, as one written by an instance that filed it from its own clock does, and that
    // clock is later than every slot a catch-up occurrence can name.
    const batch = [
      { data: { name: 'q', key: '' } },
      { data: { name: 'q', key: '', slot: slotOf(minute - 3 * MINUTE) } }
    ]

    await (tk as any).onSendIt(batch)

    const [{ params }] = tk.executed.filter(({ sql }) => sql.includes('last_job_id'))

    // The job of the newer occurrence, rather than whichever settled last.
    expect(JSON.parse(params[0] as string)).toEqual([{ name: 'q', key: '', jobId: 'job-0' }])
  })

  it('records the later occurrence of a catch-up pair whose jobs both name a slot', async function () {
    const tk = makeTk()

    const sent: string[] = []

    ;(tk as any).manager = {
      send: async () => {
        const id = `job-${sent.length}`

        sent.push(id)

        return id
      }
    }

    const minute = Math.floor(Date.now() / MINUTE) * MINUTE

    // The same pair as above with the occurrence due now naming its own slot, which is what a pass
    // files whichever format the schedule is in. A catch-up occurrence is older than the window,
    // so the slot it names is older than the due one's whatever second of the minute it fell on,
    // and the order holds without the running pass's clock standing in for either.
    const batch = [
      { data: { name: 'q', key: '', slot: slotOf(minute) } },
      { data: { name: 'q', key: '', slot: slotOf(minute - 3 * MINUTE) } }
    ]

    await (tk as any).onSendIt(batch)

    const [{ params }] = tk.executed.filter(({ sql }) => sql.includes('last_job_id'))

    expect(JSON.parse(params[0] as string)).toEqual([{ name: 'q', key: '', jobId: 'job-0' }])
  })
})
