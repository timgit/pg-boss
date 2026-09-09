import { expect } from 'vitest'
import { delay } from '../src/tools.ts'
import * as helper from './testHelper.ts'
import Timekeeper from '../src/timekeeper.ts'
import { systemClock } from '../src/clock.ts'
import { isRrule, latestOccurrenceBefore, nextOccurrence, occurrencesInWindow, assertRrule, assertRruleSends } from '../src/rrule.ts'
import { ctx } from './hooks.ts'

// Most of this needs no database: an expression is read by a pure function of (expression, after,
// tz), and the cron pass decides due-ness from the clock, both of which a bare Timekeeper answers.
const AFTER = new Date('2026-09-07T00:00:00Z')

function next (expression: string, tz = 'UTC', after: Date = AFTER): string | null {
  const occurrence = nextOccurrence(expression, after, tz)

  return occurrence ? occurrence.toISOString() : null
}

// A Timekeeper with a database that only answers the clock query, which is all the pass needs to
// judge whether a schedule has come due. Every statement it is handed is recorded, since the pass
// writes as well as reads: a row whose stored kind disagrees with its expression is relabelled.
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

/** The iCalendar spelling of an instant, for a DTSTART or an RDATE built around the clock. */
function ical (epochMs: number) {
  return new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * A pass over `schedules`, with the database clock placed at `databaseTime`, answering with the
 * jobs it forwarded.
 */
async function pass (tk: ReturnType<typeof makeTk>, databaseTime: number, schedules: unknown[]) {
  const inserted: any[] = []

  ;(tk as any).stopped = false
  ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }
  ;(tk as any).getSchedules = async () => schedules

  tk.clockSkew = databaseTime - Date.now()

  await tk.cron()

  return inserted
}

/**
 * The 60-second throttle slot a forwarded job lands in, which is what collapses a repeat send,
 * written the way the insert files it: UTC wall time, without a zone.
 */
function slotOf (epochMs: number) {
  return new Date(Math.floor(epochMs / 60_000) * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

describe('rrule', function () {
  it('tells a recurrence rule from a cron expression', function () {
    expect(isRrule('FREQ=DAILY;BYHOUR=9')).toBe(true)
    expect(isRrule('RRULE:FREQ=DAILY')).toBe(true)
    expect(isRrule('DTSTART:20260901T090000Z\nRRULE:FREQ=DAILY')).toBe(true)
    expect(isRrule('WKST=SU;FREQ=WEEKLY;BYDAY=TU')).toBe(true)

    // a line below the first one names it just as well, so a block that opens with something else
    // is still read as a rule and reported as one
    expect(isRrule('BEGIN:VEVENT\nDTSTART:20260901T090000Z\nRRULE:FREQ=DAILY\nEND:VEVENT')).toBe(true)
    expect(isRrule('SUMMARY:standup\nRRULE:FREQ=DAILY')).toBe(true)

    // no cron field can contain an `=`, a `:` or a `;`, so nothing that already worked is read as a
    // rule
    expect(isRrule('* * * * *')).toBe(false)
    expect(isRrule('0 3 * * *')).toBe(false)
    expect(isRrule('30 30 3 * * *')).toBe(false)
    expect(isRrule('0 0 1 1 *')).toBe(false)
    expect(isRrule('*/2 * * * MON-FRI')).toBe(false)
  })

  it('reads a bare recurrence rule in the schedule time zone', function () {
    // The RRULE value on its own is what a caller reaching for a cron replacement writes, and the
    // zone it recurs in is the schedule's.
    expect(next('FREQ=DAILY;BYHOUR=9')).toBe('2026-09-07T09:00:00.000Z')
    expect(next('FREQ=DAILY;BYHOUR=9', 'America/Chicago')).toBe('2026-09-07T14:00:00.000Z')
    expect(next('RRULE:FREQ=DAILY;BYHOUR=9')).toBe('2026-09-07T09:00:00.000Z')
  })

  it('anchors a rule with no DTSTART on the epoch, so every instance agrees on the phase', function () {
    // Midnight on 1970-01-01 in the schedule's own zone, which is what makes an INTERVAL land on
    // the same instants whichever instance runs the pass and whenever the schedule was created.
    expect(next('FREQ=HOURLY;INTERVAL=6')).toBe('2026-09-07T06:00:00.000Z')
    expect(next('FREQ=MINUTELY;INTERVAL=30', 'UTC', new Date('2026-09-07T00:07:00Z')))
      .toBe('2026-09-07T00:30:00.000Z')
    expect(next('FREQ=DAILY')).toBe('2026-09-08T00:00:00.000Z')
  })

  it('takes the zone from DTSTART when it names one', function () {
    // 09:00 in Berlin, whatever the schedule was given, because the expression is explicit about it
    expect(next('DTSTART;TZID=Europe/Berlin:20260901T090000\nRRULE:FREQ=DAILY', 'America/Chicago'))
      .toBe('2026-09-07T07:00:00.000Z')

    // and 09:00 in the schedule's zone when the expression leaves it floating
    expect(next('DTSTART:20260901T090000\nRRULE:FREQ=DAILY', 'America/Chicago'))
      .toBe('2026-09-07T14:00:00.000Z')
  })

  it('accepts the recurrence lines of a calendar entry', function () {
    expect(next('DTSTART:20260907T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20260907T090000Z'))
      .toBe('2026-09-08T09:00:00.000Z')

    expect(next('DTSTART:20260101T090000Z\nRRULE:FREQ=YEARLY\nRDATE:20260908T050000Z'))
      .toBe('2026-09-08T05:00:00.000Z')

    // property names are case insensitive, and an export arrives with CRLF line endings
    expect(next('dtstart:20260901T090000Z\r\nrrule:freq=daily')).toBe('2026-09-07T09:00:00.000Z')

    // a blank line between properties, and the one a trailing line break leaves at the end, are
    // neither of them a property to reject
    expect(next('DTSTART:20260901T090000Z\n\nRRULE:FREQ=DAILY\n')).toBe('2026-09-07T09:00:00.000Z')

    // a long line arrives folded, which is a line break and a space rather than a new property
    expect(next('DTSTART:20260901T090000Z\r\nRRULE:FREQ=DAILY\r\nEXDATE:20260907T090000Z,\r\n 20260908T090000Z'))
      .toBe('2026-09-09T09:00:00.000Z')
  })

  it('answers with an occurrence strictly after the one it is given', function () {
    const first = nextOccurrence('FREQ=DAILY;BYHOUR=9', AFTER, 'UTC') as Date
    const second = nextOccurrence('FREQ=DAILY;BYHOUR=9', first, 'UTC') as Date

    expect(first.toISOString()).toBe('2026-09-07T09:00:00.000Z')
    expect(second.toISOString()).toBe('2026-09-08T09:00:00.000Z')
  })

  it('reports a finite rule with nothing left as having no further occurrence', function () {
    expect(next('DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20200201T090000Z')).toBeNull()
    expect(next('DTSTART:20200101T090000Z\nRRULE:FREQ=DAILY;COUNT=3')).toBeNull()
    expect(next('DTSTART:20261001T090000Z\nRRULE:FREQ=DAILY;COUNT=3')).toBe('2026-10-01T09:00:00.000Z')
  })

  it('keeps the wall clock time across a daylight saving transition', function () {
    // 09:00 in Berlin on either side of the March transition, an hour apart in UTC
    expect(next('DTSTART:20260301T090000\nRRULE:FREQ=DAILY', 'Europe/Berlin', new Date('2026-03-27T12:00:00Z')))
      .toBe('2026-03-28T08:00:00.000Z')
    expect(next('DTSTART:20260301T090000\nRRULE:FREQ=DAILY', 'Europe/Berlin', new Date('2026-03-28T12:00:00Z')))
      .toBe('2026-03-29T07:00:00.000Z')
  })

  it('counts an hourly interval in elapsed hours and a BYHOUR list in wall clock hours', function () {
    // The epoch anchor sits in standard time and an HOURLY INTERVAL counts elapsed hours, so its
    // occurrences keep their phase in UTC and their local time moves with the offset: noon in
    // Chicago in January, one in the afternoon in July.
    expect(next('FREQ=HOURLY;INTERVAL=6', 'America/Chicago', new Date('2026-01-15T12:00:00Z')))
      .toBe('2026-01-15T18:00:00.000Z')
    expect(next('FREQ=HOURLY;INTERVAL=6', 'America/Chicago', new Date('2026-07-15T12:00:00Z')))
      .toBe('2026-07-15T18:00:00.000Z')

    // Naming the hours pins them to the clock instead, which is what the cron expression an
    // interval looks like does.
    expect(next('FREQ=DAILY;BYHOUR=0,6,12,18', 'America/Chicago', new Date('2026-01-15T12:00:00Z')))
      .toBe('2026-01-15T18:00:00.000Z')
    expect(next('FREQ=DAILY;BYHOUR=0,6,12,18', 'America/Chicago', new Date('2026-07-15T12:00:00Z')))
      .toBe('2026-07-15T17:00:00.000Z')
  })

  it('reads one expression in two zones as two rules, forwards and back', function () {
    const expression = 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=30'

    // Every read builds the rule the expression and the zone describe, so the same expression on
    // two schedules in two zones answers in each of them, and a read is not a cursor: an earlier
    // `after` after a later one gets the earlier answer.
    expect(next(expression, 'Europe/Berlin')).toBe('2026-09-07T07:30:00.000Z')
    expect(next(expression, 'UTC')).toBe('2026-09-07T09:30:00.000Z')
    expect(next(expression, 'Europe/Berlin', new Date('2026-09-07T08:00:00Z'))).toBe('2026-09-09T07:30:00.000Z')
    expect(next(expression, 'Europe/Berlin')).toBe('2026-09-07T07:30:00.000Z')
  })

  it('rejects COUNT without a DTSTART to count from', function () {
    // On the epoch anchor every count worth having is long spent, so the schedule would parse and
    // then never send anything.
    expect(() => assertRrule('FREQ=DAILY;COUNT=3', 'UTC')).toThrow(/COUNT/)
    expect(() => assertRrule('DTSTART:20991001T090000Z\nRRULE:FREQ=DAILY;COUNT=3', 'UTC')).not.toThrow()
  })

  it('rejects a rule with nothing left to send', function () {
    const now = new Date()

    // The row would sit in the table with every pass evaluating it and no job ever sent, which is
    // the one failure a caller cannot see. Judged apart from the readability checks, since a
    // preview has no reason to refuse a rule that has finished: an empty list says so.
    expect(() => assertRruleSends('FREQ=DAILY;UNTIL=20200101T000000Z', 'UTC', now))
      .toThrow('rrule expression has no occurrence left, so the schedule would never send a job')

    expect(() => assertRruleSends('DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;COUNT=3', 'UTC', now))
      .toThrow(/no occurrence left/)

    expect(() => assertRruleSends('DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;UNTIL=20990101T000000Z', 'UTC', now))
      .not.toThrow()

    // and assertRrule takes all three, since nothing about them is unreadable
    expect(() => assertRrule('FREQ=DAILY;UNTIL=20200101T000000Z', 'UTC')).not.toThrow()
  })

  it('rejects a part no parser reads rather than evaluating the rest', function () {
    expect(() => assertRrule('FREQ=DAILY;BYHOURS=9', 'UTC'))
      .toThrow('Unsupported part "BYHOURS=9" in rrule expression')

    // X- names are the extension mechanism RFC 5545 leaves open
    expect(() => assertRrule('FREQ=DAILY;X-FOO=1;BYHOUR=9', 'UTC')).not.toThrow()
  })

  it('rejects a part value the parser would drop, which would run the job at the anchor', function () {
    // An out of range value leaves the rule with no such part at all, so `BYHOUR=25` is a schedule
    // that runs at the anchor's midnight rather than one that reports a problem.
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=25', 'UTC'))
      .toThrow('Unsupported value in rrule part "BYHOUR=25"')

    expect(() => assertRrule('FREQ=DAILY;BYMINUTE=90', 'UTC')).toThrow(/Unsupported value/)
    expect(() => assertRrule('FREQ=DAILY;BYSECOND=99', 'UTC')).toThrow(/Unsupported value/)
    expect(() => assertRrule('FREQ=MONTHLY;BYMONTHDAY=32', 'UTC')).toThrow(/Unsupported value/)

    // and one value of a list dropped is a send of the day lost
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=9,25', 'UTC'))
      .toThrow('Unsupported value in rrule part "BYHOUR=9,25"')

    // a repeat of a value the parser collapses is not a value it read past
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=9,9', 'UTC')).not.toThrow()
  })

  it('reads past an empty part, which a trailing separator leaves behind', function () {
    // A trailing or doubled `;` leaves a part with nothing in it, which is not a part with a
    // mistake in it: there is no name there to have got wrong and no value there to be dropped.
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=9;', 'UTC')).not.toThrow()
    expect(next('FREQ=DAILY;;BYHOUR=9')).toBe('2026-09-07T09:00:00.000Z')
  })

  it('rejects a part with no value, which the parser dies inside on', function () {
    expect(() => assertRrule('FREQ=DAILY;BYHOUR', 'UTC')).toThrow('rrule part "BYHOUR" has no value')
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=9;UNTIL', 'UTC')).toThrow('rrule part "UNTIL" has no value')
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=', 'UTC')).toThrow('rrule part "BYHOUR=" has no value')
  })

  it('rejects a repeated part instead of evaluating the last one', function () {
    // A second BYHOUR replaces the first rather than widening it, so this is a schedule that skips
    // the morning without a word.
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=9;BYHOUR=17', 'UTC'))
      .toThrow('rrule expression has more than one BYHOUR part')

    expect(() => assertRrule('FREQ=DAILY;byhour=9;BYHOUR=17', 'UTC')).toThrow(/more than one BYHOUR/)
  })

  it('rejects an expression with no RRULE to recur on', function () {
    // rrule-temporal recurs on an RRULE and nothing else, so RDATE lines on their own are a set of
    // dates rather than a recurrence, whatever RFC 5545 allows a calendar entry to carry.
    expect(() => assertRrule('DTSTART:20991001T090000Z\nRDATE:20991008T050000Z', 'UTC'))
      .toThrow('rrule expression has no RRULE to recur on')

    expect(() => assertRrule('EXDATE:20991008T050000Z', 'UTC')).toThrow(/no RRULE to recur on/)
  })

  it('rejects a property no parser reads, which would otherwise change the anchor', function () {
    // A mistyped DTSTART would be dropped and leave the rule anchored on the epoch
    expect(() => assertRrule('DTSRAT:20260901T090000Z\nRRULE:FREQ=DAILY', 'UTC'))
      .toThrow('Unsupported property "DTSRAT" in rrule expression. Supported properties: DTSTART, RRULE, RDATE, EXDATE')

    expect(() => assertRrule('SUMMARY:standup\nRRULE:FREQ=DAILY', 'UTC')).toThrow(/Unsupported property/)
  })

  it('rejects a calendar entry with the lines wrapped around its recurrence', function () {
    // Skipping whatever sits between BEGIN and END is what would let a mistyped DTSTART through, so
    // the wrapper is reported rather than read past.
    expect(() => assertRrule('BEGIN:VEVENT\nDTSTART:20260901T090000Z\nRRULE:FREQ=DAILY\nEND:VEVENT', 'UTC'))
      .toThrow('rrule expression should be the DTSTART, RRULE, RDATE and EXDATE lines of a calendar entry, without the BEGIN and END lines around them')

    expect(() => assertRrule('BEGIN:VCALENDAR\nRRULE:FREQ=DAILY\nEND:VCALENDAR', 'UTC'))
      .toThrow(/without the BEGIN and END lines/)
  })

  it('rejects a second DTSTART or RRULE instead of quietly dropping one', function () {
    expect(() => assertRrule('RRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY', 'UTC'))
      .toThrow('rrule expression has more than one RRULE')

    expect(() => assertRrule('DTSTART:20260101T090000Z\nDTSTART:20260102T090000Z\nRRULE:FREQ=DAILY', 'UTC'))
      .toThrow('rrule expression has more than one DTSTART')
  })

  it('rejects an RDATE or EXDATE that does not carry the time of day DTSTART does', function () {
    // A date on its own is read as midnight, so the 09:00 occurrence this was meant to exclude
    // would be sent anyway, which is the holiday nobody excluded.
    expect(() => assertRrule('DTSTART:20260901T090000Z\nRRULE:FREQ=DAILY\nEXDATE;VALUE=DATE:20991224', 'UTC'))
      .toThrow('rrule EXDATE "20991224" must have the same value type as DTSTART: a date time such as 20991224T090000')

    expect(() => assertRrule('DTSTART:20260901T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20991224', 'UTC'))
      .toThrow(/same value type as DTSTART/)

    expect(() => assertRrule('DTSTART:20260901T090000Z\nRRULE:FREQ=DAILY\nRDATE:20991224', 'UTC'))
      .toThrow('rrule RDATE "20991224" must have the same value type as DTSTART: a date time such as 20991224T090000')

    // a date time is what a date time DTSTART asks for, and a date is what a date one asks for
    expect(() => assertRrule('DTSTART:20260901T090000Z\nRRULE:FREQ=DAILY\nEXDATE:20991224T090000Z', 'UTC'))
      .not.toThrow()

    expect(() => assertRrule('DTSTART;VALUE=DATE:20260901\nRRULE:FREQ=DAILY\nEXDATE;VALUE=DATE:20991224', 'UTC'))
      .not.toThrow()

    expect(() => assertRrule('DTSTART;VALUE=DATE:20260901\nRRULE:FREQ=DAILY\nEXDATE:20991224T090000Z', 'UTC'))
      .toThrow('rrule EXDATE "20991224T090000Z" must have the same value type as DTSTART: a date such as 20991224')
  })

  it('rejects a rule RFC 5545 forbids, whose reading no two engines agree on', function () {
    expect(() => assertRrule('FREQ=WEEKLY;BYMONTHDAY=1', 'UTC'))
      .toThrow(/BYMONTHDAY MUST NOT be used when FREQ is WEEKLY/)
    expect(() => assertRrule('FREQ=DAILY;BYDAY=1MO', 'UTC')).toThrow(/MUST NOT/)
    expect(() => assertRrule('FREQ=NOPE', 'UTC')).toThrow(/Invalid FREQ value/)
    expect(() => assertRrule('FREQ=DAILY;INTERVAL=0', 'UTC')).toThrow(/interval must be greater than 0/)
  })

  it('rejects an unusable time zone in the same words a cron schedule does', function () {
    expect(() => assertRrule('FREQ=DAILY;BYHOUR=9', 'America/New_Yrok'))
      .toThrow('Unknown or unsupported time zone: "America/New_Yrok"')

    // including for a rule whose DTSTART names a zone of its own, which leaves rrule-temporal
    // ignoring the one the schedule would be stored with
    expect(() => assertRrule('DTSTART;TZID=Europe/Berlin:20260901T090000\nRRULE:FREQ=DAILY', 'Nowhere/Special'))
      .toThrow('Unknown or unsupported time zone: "Nowhere/Special"')

    // the expression is judged first, so a caller with two mistakes hears about the rule
    expect(() => assertRrule('FREQ=NOPE', 'America/New_Yrok')).toThrow(/Invalid FREQ value/)
  })

  it('reads a range backwards the way the due window reads it forwards', function () {
    const hour = Date.UTC(2026, 8, 9, 0, 0, 0)
    const after = new Date(Date.UTC(2026, 8, 9, 8, 0, 0))
    const until = new Date(Date.UTC(2026, 8, 9, 12, 0, 0))

    // An RDATE is an absolute instant rather than a phase of the rule, and rrule-temporal's
    // previous() walks backwards from a phase-aligned DTSTART: handed a rule carrying one it
    // answers with the RDATE in place of the occurrence that follows it and loses everything in
    // between, so a catch-up read built on it named the wrong occurrence for every calendar entry
    // with an RDATE on it. Both directions read through between() now, so the two agree on every
    // shape.
    const shapes: Array<[string, string[]]> = [
      ['no RDATE', []],
      ['an RDATE between two occurrences', [`RDATE:${ical(Date.UTC(2026, 8, 9, 10, 30, 12))}`]],
      ['an RDATE on an occurrence', [`RDATE:${ical(Date.UTC(2026, 8, 9, 10, 0, 0))}`]],
      ['two RDATEs', [`RDATE:${ical(Date.UTC(2026, 8, 9, 10, 30, 12))}`, `RDATE:${ical(Date.UTC(2026, 8, 9, 11, 30, 12))}`]],
      ['an RDATE before the range', [`RDATE:${ical(Date.UTC(2026, 8, 9, 3, 30, 12))}`]],
      ['an RDATE after the range', [`RDATE:${ical(Date.UTC(2026, 8, 9, 20, 30, 12))}`]],
      ['an RDATE past the upper bound', [`RDATE:${ical(Date.UTC(2026, 8, 9, 11, 59, 59))}`]],
      ['an EXDATE', [`EXDATE:${ical(Date.UTC(2026, 8, 9, 10, 0, 0))}`]],
      ['an EXDATE on the upper bound', [`EXDATE:${ical(Date.UTC(2026, 8, 9, 12, 0, 0))}`]],
      ['an RDATE and an EXDATE', [`RDATE:${ical(Date.UTC(2026, 8, 9, 10, 30, 12))}`, `EXDATE:${ical(Date.UTC(2026, 8, 9, 11, 0, 0))}`]]
    ]

    for (const [shape, extra] of shapes) {
      const expression = [`DTSTART:${ical(hour)}`, 'RRULE:FREQ=HOURLY', ...extra].join('\n')

      const forwards = occurrencesInWindow(expression, after, until, 'UTC').map(date => date.toISOString())
      const backwards = latestOccurrenceBefore(expression, after, until, 'UTC')?.toISOString() ?? null

      expect(backwards, shape).toEqual(forwards[forwards.length - 1] ?? null)
    }
  })

  it('reads a range backwards on the bounds the due window leaves off at', function () {
    const noon = Date.UTC(2026, 8, 9, 12, 0, 0)
    const expression = `DTSTART:${ical(Date.UTC(2026, 8, 9, 0, 0, 0))}\nRRULE:FREQ=HOURLY`

    const read = (after: number, until: number) =>
      latestOccurrenceBefore(expression, new Date(after), new Date(until), 'UTC')?.toISOString() ?? null

    // The upper bound included and the lower excluded, which is where the due window starts: an
    // occurrence on the bound belongs to one range or the other, never both.
    expect(read(noon - 2 * 3_600_000, noon)).toBe(new Date(noon).toISOString())
    expect(read(noon - 2 * 3_600_000, noon - 1)).toBe(new Date(noon - 3_600_000).toISOString())
    expect(read(noon - 3_600_000, noon - 1)).toBeNull()

    // A range reaching back past the rule's own start, and one holding nothing at all, are both
    // answers rather than errors
    expect(read(noon - 90 * 24 * 3_600_000, noon)).toBe(new Date(noon).toISOString())
    expect(read(noon - 60_000, noon - 30_000)).toBeNull()
    expect(read(noon, noon)).toBeNull()
  })

  it('reads backwards past a stretch the rule is empty over', function () {
    const noon = Date.UTC(2026, 8, 9, 12, 0, 0)
    const day = 24 * 3_600_000

    // The read widens its steps backwards to reach a sparse expression over a long gap, which is a
    // guess about density that a rule empty near the window and dense behind it defeats: a step
    // grows until it spans more occurrences than rrule-temporal generates in one call, and it
    // throws rather than truncating. Narrowing on the overrun is what keeps each of these an
    // answer, and the widening is what keeps the sparse ones cheap.
    const shapes: Array<[string, string, number]> = [
      ['minutely, still recurring', 'FREQ=MINUTELY', noon],
      ['minutely, spent an hour back', `FREQ=MINUTELY;UNTIL=${ical(noon - 3_600_000)}`, noon - 3_600_000],
      ['minutely, spent a day back', `FREQ=MINUTELY;UNTIL=${ical(noon - day)}`, noon - day],
      ['minutely, spent three days back', `FREQ=MINUTELY;UNTIL=${ical(noon - 3 * day)}`, noon - 3 * day],
      ['secondly, spent a day back', `FREQ=SECONDLY;UNTIL=${ical(noon - day)}`, noon - day],
      ['secondly, spent twenty days back', `FREQ=SECONDLY;UNTIL=${ical(noon - 20 * day)}`, noon - 20 * day],
      ['daily at nine', 'FREQ=DAILY;BYHOUR=9', Date.UTC(2026, 8, 9, 9, 0, 0)],
      ['monthly on the last friday', 'FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', Date.UTC(2026, 7, 28, 17, 0, 0)]
    ]

    for (const [shape, rule, expected] of shapes) {
      const expression = `DTSTART:${ical(Date.UTC(2025, 0, 1, 0, 0, 0))}\nRRULE:${rule}`

      const occurrence = latestOccurrenceBefore(expression, new Date(noon - 30 * day), new Date(noon), 'UTC')

      expect(occurrence?.toISOString(), shape).toBe(new Date(expected).toISOString())
    }
  })

  it('reports a rule it cannot read at its narrowest step rather than looping on it', function () {
    const noon = Date.UTC(2026, 8, 9, 12, 0, 0)

    // A COUNT rule is the one shape rrule-temporal cannot start near the window for, since the
    // occurrence set depends on the index from the true DTSTART, so it walks from there and gives
    // up at its iteration ceiling. Narrowing the step cannot help with that, and pretending the
    // range is empty would send nothing and say nothing, so the read says what happened. The due
    // window read refuses the same expression, which is what the pass reports first.
    const expression = `DTSTART:${ical(Date.UTC(2020, 0, 1, 0, 0, 0))}
RRULE:FREQ=SECONDLY;COUNT=500000`

    expect(() => latestOccurrenceBefore(expression, new Date(noon - 30 * 24 * 3_600_000), new Date(noon), 'UTC'))
      .toThrow(/Maximum iterations/)

    expect(() => occurrencesInWindow(expression, new Date(noon - 60_000), new Date(noon), 'UTC'))
      .toThrow(/Maximum iterations/)
  })

  it('fires a rule whose occurrence falls inside the window, measured on the database clock', function () {
    const tk = makeTk()
    tk.clockSkew = 120_000 // db 2 minutes ahead of local

    // a minutely rule: the previous boundary is always less than 60s before database time, whatever
    // the skew, exactly as the equivalent cron expression behaves
    expect(tk.shouldSendIt('FREQ=MINUTELY', 'UTC', 'rrule')).toBe(true)
    expect(tk.shouldSendIt('FREQ=SECONDLY;INTERVAL=15', 'UTC', 'rrule')).toBe(true)
  })

  it('does not fire a rule with no occurrence in the window', function () {
    const tk = makeTk()

    // finished: the last occurrence is years back
    expect(tk.shouldSendIt('DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY;UNTIL=20200201T000000Z', 'UTC', 'rrule')).toBe(false)

    // not started: the first occurrence is years out
    expect(tk.shouldSendIt('DTSTART:20991231T000000Z\nRRULE:FREQ=DAILY', 'UTC', 'rrule')).toBe(false)
  })

  it('files a rule occurrence in the throttle slot the occurrence falls in, not the one insert time does', async function () {
    const tk = makeTk()
    ;(tk as any).stopped = false

    const inserted: any[] = []
    ;(tk as any).manager = { insert: async (_q: string, jobs: any[]) => { inserted.push(...jobs) } }

    // Occurrences on the half minute, so two passes can find the same one inside the window from
    // opposite sides of a slot boundary.
    ;(tk as any).getSchedules = async () => ([
      { name: 'rule', key: '', data: null, options: {}, kind: 'rrule', cron: 'FREQ=MINUTELY;BYSECOND=30', timezone: 'UTC' },
      { name: 'cron', key: '', data: null, options: {}, kind: 'cron', cron: '* * * * *', timezone: 'UTC' }
    ])

    // The most recent occurrence, which the skew below places the database clock relative to. Both
    // passes see this one: the window is a minute wide and the occurrences are a minute apart.
    const now = Date.now()
    const occurrence = Math.floor((now - 30_000) / 60_000) * 60_000 + 30_000

    // five seconds after the occurrence, in its own slot
    tk.clockSkew = occurrence + 5_000 - now
    await tk.cron()

    // and forty-five seconds after it, by which point insert time has moved into the next slot
    tk.clockSkew = occurrence + 45_000 - now
    await tk.cron()

    const [first, second] = inserted.filter(job => job.singletonKey === 'rule__')

    // Both passes name the slot the occurrence falls in, so the second job collapses into the first
    // instead of being sent as a job of its own. A slot rather than an offset from the insert's own
    // clock, so nothing the round trip costs can move it.
    expect(first.__singletonSlot).toBe(slotOf(occurrence))
    expect(second.__singletonSlot).toBe(slotOf(occurrence))
    expect(first.singletonSeconds).toBeUndefined()

    // A cron occurrence keeps the slot every release has always filed it in: during a rolling
    // upgrade an instance on an older release computes that slot and no other.
    for (const job of inserted.filter(job => job.singletonKey === 'cron__')) {
      expect(job.singletonSeconds).toBe(60)
      expect(job.__singletonSlot).toBeUndefined()
    }
  })

  it('sends a job for each occurrence that falls inside one window', async function () {
    const tk = makeTk()

    // The shape a calendar export produces: an hourly rule with a one-off RDATE seconds before one
    // of its occurrences. The two are closer together than the interval between passes, so no pass
    // can land between them, and a read answering with a single occurrence drops one of them
    // whatever direction it reads in.
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000
    const rdate = hour - 5_000

    const cron = [
      `DTSTART:${ical(hour - 3_600_000)}`,
      'RRULE:FREQ=HOURLY',
      `RDATE:${ical(rdate)}`
    ].join('\n')

    const inserted = await pass(tk, hour + 1_000, [
      { name: 'rule', key: '', data: null, options: {}, kind: 'rrule', cron, timezone: 'UTC' }
    ])

    // Both, each filed in the slot it falls in, so the throttle collapses a repeat of either
    // without either standing in for the other.
    expect(inserted.map(job => job.__singletonSlot)).toEqual([slotOf(rdate), slotOf(hour)])
  })

  it('sends at most one job for the minute an occurrence falls in', async function () {
    const tk = makeTk()

    // Four occurrences a window, which is the resolution the 6-placeholder cron format has and the
    // same reason: a job a minute is what the throttle slot allows.
    const minute = Math.floor(Date.now() / 60_000) * 60_000

    const inserted = await pass(tk, minute + 30_000, [
      { name: 'rule', key: '', data: null, options: {}, kind: 'rrule', cron: 'FREQ=SECONDLY;INTERVAL=15', timezone: 'UTC' }
    ])

    // One job for each of the two minutes the window spans, filed under the minute the occurrences
    // in it belong to rather than the minute the pass ran in.
    expect(inserted.map(job => job.__singletonSlot)).toEqual([slotOf(minute - 60_000), slotOf(minute)])
  })

  it('collapses two jobs filed in one throttle slot and keeps two filed in different slots', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const insert = (__singletonSlot: string) =>
      ctx.boss!.insert(ctx.schema, [{ singletonKey: 'rule__', __singletonSlot }] as any, { returnId: true, __singletonSlots: true } as any)

    // The slot a rule occurrence names, filed twice as two passes on either side of a boundary
    // would file it, then a slot of its own for the occurrence a minute later.
    expect(await insert('2026-09-07 12:00:00')).toHaveLength(1)
    expect(await insert('2026-09-07 12:00:00')).toBeNull()
    expect(await insert('2026-09-07 12:01:00')).toHaveLength(1)
  })

  it('leaves a singletonSlot on the insert() path where it always was: ignored', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // The slot is an internal field of the cron pass, not a send option. insert() spreads caller
    // objects straight into the recordset, so the column is declared only in the statement the pass
    // asks for and the field is dropped from the objects insert() is handed: under either spelling
    // a caller neither files the job nor reaches the timestamp cast with an unvalidated value.
    for (const field of ['singletonSlot', '__singletonSlot']) {
      const [id] = await ctx.boss.insert(ctx.schema, [{ [field]: 'not-a-timestamp' }] as any, { returnId: true }) ?? []

      expect(id).toBeTruthy()

      const [job] = await ctx.boss.findJobs(ctx.schema, { id })

      expect(job.singletonOn).toBeNull()
    }
  })

  it('sends a job for a schedule created from a recurrence rule', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    // Minutely, so an occurrence is always inside the window and the first pass sends a job, the
    // same way `* * * * *` does.
    await ctx.boss.schedule(ctx.schema, 'FREQ=MINUTELY')

    await delay(4000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeTruthy()

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.kind).toBe('rrule')
    expect(schedule.cron).toBe('FREQ=MINUTELY')
    expect(schedule.timezone).toBe('UTC')
  })

  it('records which format a schedule is in, and rewrites it when the expression is replaced', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const kindOf = async () => (await ctx.boss!.getSchedules(ctx.schema, 'nightly'))[0].kind

    await ctx.boss.schedule(ctx.schema, '0 3 * * *', null, { key: 'nightly' })
    expect(await kindOf()).toBe('cron')

    // Replacing the expression on a key that already exists has to carry the format with it, or the
    // row keeps the kind of the expression it no longer holds and every later pass reads it wrong.
    await ctx.boss.schedule(ctx.schema, 'FREQ=DAILY;BYHOUR=3', null, { key: 'nightly' })
    expect(await kindOf()).toBe('rrule')

    await ctx.boss.schedule(ctx.schema, '0 3 * * *', null, { key: 'nightly' })
    expect(await kindOf()).toBe('cron')
  })

  it('fires a row whose stored kind disagrees with its expression, and relabels it', async function () {
    // Both directions of the disagreement. A 12.30.x instance's schedule() does not name the
    // column, so an upsert from one during a rolling upgrade leaves the kind a newer instance
    // wrote on the expression it has just replaced; a v41 rollback and re-upgrade labels a rule
    // cron from the column default. Either way the row reads fine and, taking the column as a
    // verdict, never fires again.
    for (const [kind, cron] of [['cron', 'FREQ=MINUTELY'], ['rrule', '* * * * *']]) {
      const tk = makeTk()

      const warnings: any[] = []
      tk.on('warning', (w: any) => warnings.push(w))

      const inserted = await pass(tk, Date.now(), [
        { name: 'mislabelled', key: 'eu', data: null, options: {}, kind, cron, timezone: 'UTC' }
      ])

      expect(inserted).toHaveLength(1)
      expect(warnings).toHaveLength(0)

      // and the row is put right, so getSchedules() stops reporting a format the expression is not
      // in and the next pass reads it without the fallback
      const relabel = tk.executed.find(({ sql }) => /UPDATE .*schedule .*SET kind/s.test(sql))

      // Carrying the expression the label was read off, so a schedule() upsert landing between this
      // pass's read and its write is not stamped with the previous expression's kind.
      expect(JSON.parse(relabel!.params[0] as string))
        .toEqual([{ name: 'mislabelled', key: 'eu', kind: kind === 'cron' ? 'rrule' : 'cron', cron }])
    }
  })

  it('warns about an expression that cannot be read either way', async function () {
    for (const [kind, cron] of [['cron', 'not a cron expression'], ['rrule', 'FREQ=NOPE']]) {
      const tk = makeTk()

      const warnings: any[] = []
      tk.on('warning', (w: any) => warnings.push(w))

      const inserted = await pass(tk, Date.now(), [
        { name: 'broken', key: '', data: null, options: {}, kind, cron, timezone: 'UTC' }
      ])

      expect(inserted).toHaveLength(0)
      expect(warnings).toHaveLength(1)
      expect(warnings[0].message).toMatch(/broken/)

      // nothing to relabel: the expression is what is wrong with the row, not the column
      expect(tk.executed.some(({ sql }) => /SET kind/.test(sql))).toBe(false)
    }
  })

  it('refuses an unusable rule at schedule() time rather than storing it', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(ctx.boss.schedule(ctx.schema, 'FREQ=DAILY;BYHOURS=9')).rejects.toThrow(/Unsupported part/)

    await expect(ctx.boss.schedule(ctx.schema, 'FREQ=DAILY;BYHOUR=25')).rejects.toThrow(/Unsupported value/)

    await expect(ctx.boss.schedule(ctx.schema, 'FREQ=DAILY', null, { tz: 'Nowhere/Special' }))
      .rejects.toThrow(/Unknown or unsupported time zone/)

    // A block whose first line names something else is read as a rule all the same, so what reaches
    // the caller is the property nobody supports rather than the characters cron-parser cannot read
    await expect(ctx.boss.schedule(ctx.schema, 'SUMMARY:standup\nRRULE:FREQ=DAILY'))
      .rejects.toThrow('Unsupported property "SUMMARY" in rrule expression. Supported properties: DTSTART, RRULE, RDATE, EXDATE')

    await expect(ctx.boss.schedule(ctx.schema, 'BEGIN:VEVENT\nDTSTART:20260901T090000Z\nRRULE:FREQ=DAILY\nEND:VEVENT'))
      .rejects.toThrow(/without the BEGIN and END lines/)

    expect(await ctx.boss.getSchedules()).toHaveLength(0)
  })
})
