import { CronExpressionParser } from 'cron-parser'

// Next time a cron schedule will fire, evaluated in the schedule's timezone. Mirrors how pg-boss
// core schedules sends (src/timekeeper.ts: parse with { tz, strict: false }). Defaults to UTC when
// no timezone is set, and returns null for an unparseable cron so the UI can show a dash rather than
// failing the whole list.
export function nextCronOccurrence (cron: string, timezone?: string | null): Date | null {
  try {
    const interval = CronExpressionParser.parse(cron, { tz: timezone || 'UTC', strict: false })
    return interval.next().toDate()
  } catch {
    return null
  }
}
