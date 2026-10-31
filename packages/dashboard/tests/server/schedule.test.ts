import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { describeSchedule, nextScheduleOccurrence } from '~/lib/schedule.server'

describe('nextScheduleOccurrence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes the next fire time in UTC by default', () => {
    // Daily at 02:00 — from 12:00 on the 15th, the next fire is 02:00 on the 16th.
    const next = nextScheduleOccurrence('0 2 * * *')
    expect(next?.toISOString()).toBe('2024-01-16T02:00:00.000Z')
  })

  it('honors the schedule timezone', () => {
    // 02:00 in New York (UTC-5 in January) is 07:00 UTC.
    const next = nextScheduleOccurrence('0 2 * * *', 'America/New_York')
    expect(next?.toISOString()).toBe('2024-01-16T07:00:00.000Z')
  })

  it('treats an empty timezone as UTC', () => {
    const next = nextScheduleOccurrence('0 2 * * *', '')
    expect(next?.toISOString()).toBe('2024-01-16T02:00:00.000Z')
  })

  it('returns a future date for a frequent schedule', () => {
    const next = nextScheduleOccurrence('*/15 * * * *')
    expect(next?.toISOString()).toBe('2024-01-15T12:15:00.000Z')
  })

  it('evaluates a recurrence rule, in its timezone', () => {
    // The rrule kind reads through the same method, so a rule row gets a real next occurrence
    // instead of the dash an expression the cron parser refuses would have produced.
    expect(nextScheduleOccurrence('FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0')?.toISOString())
      .toBe('2024-01-16T02:00:00.000Z')
    expect(nextScheduleOccurrence('FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0', 'America/New_York')?.toISOString())
      .toBe('2024-01-16T07:00:00.000Z')
  })

  it('returns null for a rule that has no occurrences left', () => {
    expect(nextScheduleOccurrence('FREQ=DAILY;UNTIL=20240101T000000Z')).toBeNull()
  })

  it('returns null for an unparseable expression', () => {
    expect(nextScheduleOccurrence('not a cron')).toBeNull()
    expect(nextScheduleOccurrence('99 99 99 99 99')).toBeNull()
    expect(nextScheduleOccurrence('FREQ=NONSENSE')).toBeNull()
  })
})

describe('describeSchedule', () => {
  it('describes a cron expression', () => {
    expect(describeSchedule('0 2 * * *', 'cron')).toBe('At 02:00 AM')
    expect(describeSchedule('0 4 * * 0', 'cron')).toBe('At 04:00 AM, only on Sunday')
    expect(describeSchedule('*/15 * * * *', 'cron')).toBe('Every 15 minutes')
    expect(describeSchedule('0 4 * * 1-5', 'cron')).toBe('At 04:00 AM, Monday through Friday')
    // A row read off a database older than schema v41 has no kind, and is cron.
    expect(describeSchedule('0 0 1 * *')).toBe('At 12:00 AM, on day 1 of the month')
  })

  it('describes a recurrence rule without its time zone', () => {
    expect(describeSchedule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30', 'rrule', 'Europe/London')).toBe('Every weekday at 8:30 AM')
    expect(describeSchedule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0', 'rrule')).toBe('Every month on last Friday at 5 PM')
    expect(describeSchedule('FREQ=DAILY;BYHOUR=8,17', 'rrule', 'America/Chicago')).toBe('Every day at 8 AM and 5 PM')
  })

  it('reads the lines of a calendar entry', () => {
    expect(describeSchedule('DTSTART:20240101T000000\nRRULE:FREQ=DAILY;BYHOUR=9\nEXDATE:20241225T090000', 'rrule')).toBe('Every day at 9 AM excluding 1 date')
  })

  it('answers null for an expression it cannot read', () => {
    expect(describeSchedule('not a cron', 'cron')).toBeNull()
    expect(describeSchedule('FREQ=SOMETIMES', 'rrule')).toBeNull()
  })
})
