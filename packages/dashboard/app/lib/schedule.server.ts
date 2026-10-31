import cronstrue from 'cronstrue'
import { PgBoss, type ScheduleKind } from 'pg-boss'
import { RRuleTemporal } from 'rrule-temporal'
import { toText } from 'rrule-temporal/totext'

// pg-boss evaluates both schedule kinds — cron expressions and RRULE recurrence rules — and
// previewSchedule() is the method it exposes for asking when one fires next. It is pure computation:
// the walk never touches the database, and passing `from` keeps it off the one property (the
// database clock) that would need a live connection. So the dashboard borrows the core's own
// evaluator through an instance that is constructed and never started, rather than reimplementing
// either parser and drifting from what the schedule pass will actually do.
const evaluator = new PgBoss({ connectionString: 'postgres://pg-boss-dashboard/unused' })

/**
 * Next time a schedule fires, evaluated in its own timezone, or null when there is no next time:
 * an expression neither parser accepts, or a finite rule with nothing left to send. Both cases are
 * a dash in the UI rather than a failed page.
 *
 * Defaults to UTC when the row carries no timezone, which is what the core does with a schedule
 * written before the column was validated.
 */
export function nextScheduleOccurrence (expression: string, timezone?: string | null): Date | null {
  try {
    const [next] = evaluator.previewSchedule(expression, {
      tz: timezone || 'UTC',
      count: 1,
      from: new Date()
    })
    return next ?? null
  } catch {
    return null
  }
}

/**
 * What the Frequency column says for a schedule, such as "At 02:00 AM, only on Sunday" or "Every
 * weekday at 8:30 AM", or null for an expression neither describer reads.
 *
 * The time zone is left off, since the row shows it beside the description. A row with no kind was
 * written before schema v41 and is cron.
 */
export function describeSchedule (expression: string, kind?: ScheduleKind, timezone?: string | null): string | null {
  try {
    if (kind !== 'rrule') {
      // 12-hour, as the recurrence rule describer has no other.
      return cronstrue.toString(expression)
    }

    // A bare rule is the value of an RRULE line, and one with no DTSTART recurs from the epoch, as
    // the core reads it.
    const lines = expression.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .map((line) => /^[a-z][a-z0-9-]*[;:]/i.test(line) ? line : `RRULE:${line}`)

    if (!lines.some((line) => /^DTSTART[;:]/i.test(line))) {
      lines.unshift('DTSTART:19700101T000000')
    }

    const rule = new RRuleTemporal({ rruleString: lines.join('\n'), tzid: timezone || 'UTC' })
    const text = toText(rule, 'en', { excludeTzAbbreviation: true })

    return text.charAt(0).toUpperCase() + text.slice(1)
  } catch {
    return null
  }
}
