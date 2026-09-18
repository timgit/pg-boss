import { expect, vi } from 'vitest'
import * as helper from './testHelper.ts'
import Timekeeper from '../src/timekeeper.ts'
import { systemClock } from '../src/clock.ts'
import { ctx } from './hooks.ts'

// A timekeeper over a stub database, for the paths that never reach one: previewSchedule() is pure
// arithmetic, and getSchedule() checks its argument before it queries anything.
function makeTk (config: object = {}) {
  const db = { executeSql: async () => ({ rows: [] }) }
  return new Timekeeper(db as any, {} as any, { schema: 'test', clock: systemClock, ...config } as any)
}

describe('getSchedule', function () {
  it('should return a single schedule by queue name and key', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'a' })

    const schedule = await ctx.boss.getSchedule(ctx.schema, 'a')

    helper.assertTruthy(schedule)
    expect(schedule.name).toBe(ctx.schema)
    expect(schedule.key).toBe('a')
    expect(schedule.cron).toBe('0 1 * * *')
  })

  it('should return the default-key schedule when no key is given', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'a' })

    const schedule = await ctx.boss.getSchedule(ctx.schema)

    helper.assertTruthy(schedule)
    expect(schedule.key).toBe('')
    expect(schedule.cron).toBe('* * * * *')
  })

  it('should return null when the schedule does not exist', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    expect(await ctx.boss.getSchedule(ctx.schema, 'nope')).toBeNull()
  })

  it('should reject a missing queue name', async function () {
    const tk = makeTk()

    // @ts-expect-error deliberately calling without the required queue name
    await expect(tk.getSchedule()).rejects.toThrow(/Name is required/)
  })

  it('should return null for a name that could never have been stored', async function () {
    const tk = makeTk()

    // getSchedules() answers this with an empty array rather than a throw, and this reads the same
    // rows, so it answers with the null that array destructures to
    expect(await tk.getSchedule('not a queue name')).toBeNull()
  })
})

// Pure computation: no database, no running instance.
describe('previewSchedule', function () {
  it('should return the next occurrences after the reference date', function () {
    const tk = makeTk()

    const occurrences = tk.previewSchedule('0 3 * * *', { from: new Date('2026-03-01T00:00:00Z'), count: 3 })

    expect(occurrences.map(d => d.toISOString())).toEqual([
      '2026-03-01T03:00:00.000Z',
      '2026-03-02T03:00:00.000Z',
      '2026-03-03T03:00:00.000Z'
    ])
  })

  it('should evaluate the expression in the supplied time zone', function () {
    const tk = makeTk()

    const [first] = tk.previewSchedule('0 3 * * *', {
      tz: 'America/Chicago',
      from: new Date('2026-03-01T00:00:00Z'),
      count: 1
    })

    // 3am US central on March 1 is still standard time (UTC-6)
    expect(first.toISOString()).toBe('2026-03-01T09:00:00.000Z')
  })

  it('should default to five occurrences', function () {
    const tk = makeTk()

    expect(tk.previewSchedule('* * * * *').length).toBe(5)
  })

  it('should exclude the reference date itself so pages do not overlap', function () {
    const tk = makeTk()

    const from = new Date('2026-03-01T03:00:00Z')
    const [first] = tk.previewSchedule('0 3 * * *', { from, count: 1 })

    expect(first.toISOString()).toBe('2026-03-02T03:00:00.000Z')

    // handing the last occurrence back in yields the next page
    const [next] = tk.previewSchedule('0 3 * * *', { from: first, count: 1 })
    expect(next.toISOString()).toBe('2026-03-03T03:00:00.000Z')
  })

  it('should start from database time when no reference date is given', function () {
    const tk = makeTk()

    // Both readings have to come from one instant. Taken from the real clock, the two calls
    // straddle an hour boundary every so often and land on the same occurrence.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T10:30:00Z'))

    try {
      // an hour of clock skew has to move the first occurrence of an hourly expression
      tk.clockSkew = 60 * 60 * 1000

      const [skewed] = tk.previewSchedule('0 * * * *', { count: 1 })

      tk.clockSkew = 0

      const [local] = tk.previewSchedule('0 * * * *', { count: 1 })

      expect(skewed.toISOString()).toBe('2026-03-01T12:00:00.000Z')
      expect(local.toISOString()).toBe('2026-03-01T11:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('should reject an expression schedule() would reject', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('bogus')).toThrow()
  })

  it('should report the expression rather than the count when both are wrong', function () {
    const tk = makeTk()

    // a count the caller can fix in isolation would otherwise hide an expression that could never
    // be stored, and the caller would fix one thing only to meet the other
    expect(() => tk.previewSchedule('bogus', { count: 0 })).toThrow()
    expect(() => tk.previewSchedule('bogus', { count: 0 })).not.toThrow(/count/)
  })

  it('should reject an unusable time zone', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('* * * * *', { tz: 'Mars/Phobos' })).toThrow(/time zone/)
  })

  it('should read a falsy time zone as UTC rather than as the host zone', function () {
    const tk = makeTk()

    const utc = tk.previewSchedule('0 3 * * *', { tz: 'UTC', from: new Date('2026-03-01T00:00:00Z'), count: 2 })

    // schedule.timezone is nullable, so a row written before schedule() validated zones reads back
    // as null, and so does a zone threaded out of a config object. cron-parser takes a non-string
    // zone for "no zone" and evaluates in the host's local zone, which is a wrong answer rather
    // than a failure: whichever instance ran the pass decided when the job went out. Falsy means
    // "none given", which is documented as UTC, so the two agree here and in the pass.
    for (const tz of [null, undefined, '', 0]) {
      const occurrences = tk.previewSchedule('0 3 * * *', { tz, from: new Date('2026-03-01T00:00:00Z'), count: 2 } as any)

      expect(occurrences.map(d => d.toISOString())).toEqual(utc.map(d => d.toISOString()))
    }

    // A zone that says something unusable still throws
    expect(() => tk.previewSchedule('0 3 * * *', { tz: {} as any })).toThrow(/time zone/)
  })

  it('should reject a count outside the supported range', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('* * * * *', { count: 0 })).toThrow(/count/)
    expect(() => tk.previewSchedule('* * * * *', { count: 1001 })).toThrow(/count/)
    expect(() => tk.previewSchedule('* * * * *', { count: 1.5 })).toThrow(/count/)
  })

  it('should reject an invalid reference date', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('* * * * *', { from: new Date('nope') })).toThrow(/from/)
  })

  it('should give up on a walk that outruns its time budget', function () {
    const tk = makeTk()

    // A second of real sparse expression would make this test cost a second and its outcome depend
    // on how fast the machine is, so the clock is what moves instead: every reading is a second
    // later than the last, and the budget is spent within a couple of occurrences.
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000))

    try {
      expect(() => tk.previewSchedule('* * * * *', { from: new Date('2026-03-01T00:00:00Z'), count: 100 }))
        .toThrow(/Gave up after \d+ms with \d+ of 100 occurrences/)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('previewSchedule of a recurrence rule', function () {
  it('should walk a rule the same way it walks a cron expression', function () {
    const tk = makeTk()

    const occurrences = tk.previewSchedule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', {
      tz: 'America/Chicago',
      from: new Date('2026-03-01T00:00:00Z'),
      count: 3
    })

    // the last Friday of the month at 5pm in Chicago, which is what no cron expression can say
    expect(occurrences.map(d => d.toISOString())).toEqual([
      '2026-03-27T22:00:00.000Z',
      '2026-04-24T22:00:00.000Z',
      '2026-05-29T22:00:00.000Z'
    ])
  })

  it('should page a rule on the occurrence handed back', function () {
    const tk = makeTk()

    const [first] = tk.previewSchedule('FREQ=DAILY;BYHOUR=3', { from: new Date('2026-03-01T03:00:00Z'), count: 1 })

    expect(first.toISOString()).toBe('2026-03-02T03:00:00.000Z')

    const [next] = tk.previewSchedule('FREQ=DAILY;BYHOUR=3', { from: first, count: 1 })

    expect(next.toISOString()).toBe('2026-03-03T03:00:00.000Z')
  })

  it('should walk a rule to the count ceiling inside the time budget', function () {
    const tk = makeTk()

    // The walk builds the rule once and closes over it, the way the cron walk keeps one parsed
    // interval. Building it per occurrence put the parse inside the loop, so the ceiling spent most
    // of the budget rebuilding one expression a thousand times, and a sparse rule near the ceiling
    // loses occurrences to that rather than only milliseconds.
    const occurrences = tk.previewSchedule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', {
      from: new Date('2026-03-01T00:00:00Z'),
      count: 1000
    })

    expect(occurrences).toHaveLength(1000)
    expect(occurrences[0].toISOString()).toBe('2026-03-27T17:00:00.000Z')
    expect(occurrences[999].getTime()).toBeGreaterThan(occurrences[998].getTime())
  })

  it('should answer a finite rule with what is left of it', function () {
    const tk = makeTk()

    const from = new Date('2026-03-01T00:00:00Z')

    // COUNT and UNTIL both run out, and fewer occurrences than asked for is the answer rather than
    // a failure: it is how a caller learns the schedule is nearly done.
    expect(tk.previewSchedule('DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;COUNT=3', { from, count: 5 })).toHaveLength(3)

    // and nothing at all, for a rule whose last occurrence has passed. schedule() refuses to store
    // one of those; previewing an already-stored one has to be able to say so.
    expect(tk.previewSchedule('DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20200201T000000Z', { from })).toEqual([])
  })

  it('should reject a rule schedule() would reject', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('FREQ=DAILY;BYHOURS=9')).toThrow(/Unsupported part/)
    expect(() => tk.previewSchedule('FREQ=DAILY;BYHOUR=25')).toThrow(/Unsupported value/)
    expect(() => tk.previewSchedule('FREQ=DAILY', { tz: 'Mars/Phobos' })).toThrow(/time zone/)
  })
})

describe('previewSchedule of a stored schedule', function () {
  it('should agree with the expression the schedule was stored with', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *', null, { key: 'daily', tz: 'America/Chicago' })

    const schedule = await ctx.boss.getSchedule(ctx.schema, 'daily')

    helper.assertTruthy(schedule)

    const occurrences = ctx.boss.previewSchedule(schedule.cron, {
      tz: schedule.timezone,
      from: new Date('2026-03-01T00:00:00Z'),
      count: 2
    })

    expect(occurrences.map(d => d.toISOString())).toEqual([
      '2026-03-01T09:00:00.000Z',
      '2026-03-02T09:00:00.000Z'
    ])
  })

  it('should preview a legacy row whose time zone was never stored', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.createQueue('legacy')

    const db = await helper.getDb()

    try {
      // The row `schedule({ tz: null })` wrote on a release whose destructuring default only
      // covered `undefined`. The v41 migration retires the ones already in the table, and the read
      // coalesces whatever an older instance writes during a rolling upgrade, so Schedule.timezone
      // is the string its type says it is and the documented recipe below previews rather than
      // throwing.
      await db.executeSql(`INSERT INTO ${ctx.schema}.schedule (name, key, cron, timezone) VALUES ('legacy', '', '0 3 * * *', NULL)`)
    } finally {
      await db.close()
    }

    const schedule = await ctx.boss.getSchedule('legacy')

    helper.assertTruthy(schedule)
    expect(schedule.timezone).toBe('UTC')

    const occurrences = ctx.boss.previewSchedule(schedule.cron, {
      tz: schedule.timezone,
      from: new Date('2026-03-01T00:00:00Z'),
      count: 1
    })

    expect(occurrences.map(d => d.toISOString())).toEqual(['2026-03-01T03:00:00.000Z'])
  })

  it('should read a stored rule without being told which format it is in', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, 'FREQ=DAILY;BYHOUR=3', null, { key: 'daily', tz: 'America/Chicago' })

    const schedule = await ctx.boss.getSchedule(ctx.schema, 'daily')

    helper.assertTruthy(schedule)
    expect(schedule.kind).toBe('rrule')

    // The same two arguments a cron schedule is previewed with: the expression says which format it
    // is in, the same way schedule() decided when it stored the row.
    const occurrences = ctx.boss.previewSchedule(schedule.cron, {
      tz: schedule.timezone,
      from: new Date('2026-03-01T00:00:00Z'),
      count: 2
    })

    expect(occurrences.map(d => d.toISOString())).toEqual([
      '2026-03-01T09:00:00.000Z',
      '2026-03-02T09:00:00.000Z'
    ])
  })
})
