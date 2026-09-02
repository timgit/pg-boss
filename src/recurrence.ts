import assert from 'node:assert'
import { CronExpressionParser } from 'cron-parser'
import { CRON_KIND } from './plans.ts'
import type * as types from './types.ts'

// The one recurrence kind pg-boss implements itself. Everything else arrives through the
// `recurrences` constructor option, the same way work() handlers arrive through the process
// rather than the database.
export { CRON_KIND }

/**
 * Asserts that `tz` is a time zone cron evaluation can actually use.
 *
 * cron-parser validates `tz` lazily: parsing without a reference date never constructs a CronDate,
 * so every string is accepted and a bad zone only surfaces later, when a date is computed, as an
 * opaque "CronDate: unhandled timestamp". Passing a reference date here forces that construction so
 * a typo like 'America/New_Yrok' is rejected by schedule() rather than persisted to the schedule
 * table. Deliberately reuses cron-parser rather than an independent Intl check, so what schedule()
 * accepts is exactly what the cron pass can evaluate.
 *
 * The caller validates the cron expression first, so a failure here is attributable to the zone.
 */
export function assertTimezone (tz: string): void {
  try {
    CronExpressionParser.parse('* * * * *', { tz, strict: false, currentDate: new Date() })
  } catch {
    // Quoted so an empty string renders as `""` rather than a dangling colon
    throw new Error(`Unknown or unsupported time zone: "${tz}"`)
  }
}

export const cronRecurrence: types.RecurrenceParser = {
  next (expression, after, tz) {
    return CronExpressionParser
      .parse(expression, { tz, strict: false, currentDate: after })
      .next()
      .toDate()
  },
  validate (expression, tz) {
    // Expression first, so a bad expression reports as one rather than as a time zone problem. The
    // check is deliberately run against UTC rather than the supplied tz: it only works today
    // because cron-parser is lazy about an unusable zone, and if that ever changes this call would
    // throw the opaque "CronDate: unhandled timestamp" that assertTimezone exists to replace.
    CronExpressionParser.parse(expression, { tz: 'UTC', strict: false })
    assertTimezone(tz)
  }
}

/**
 * Validates the `recurrences` constructor option. Called from the config resolver so a
 * malformed parser is a constructor error, not a surprise on the first cron pass.
 */
export function assertRecurrenceConfig (recurrences: unknown): void {
  assert(typeof recurrences === 'object' && recurrences !== null && !Array.isArray(recurrences),
    'configuration assert: recurrences must be an object keyed by recurrence kind')

  for (const [kind, parser] of Object.entries(recurrences as Record<string, unknown>)) {
    assert(kind.length > 0, 'configuration assert: a recurrence kind cannot be an empty string')

    assert(kind !== CRON_KIND,
      `configuration assert: "${CRON_KIND}" is built in and cannot be replaced by a registered parser`)

    assert(typeof parser === 'object' && parser !== null,
      `configuration assert: recurrence "${kind}" must be an object with a next() function`)

    const { next, validate } = parser as types.RecurrenceParser

    assert(typeof next === 'function',
      `configuration assert: recurrence "${kind}" must have a next(expression, after, tz) function`)

    assert(validate === undefined || typeof validate === 'function',
      `configuration assert: recurrence "${kind}" validate must be a function`)
  }
}

/** The kinds this process can evaluate: the built-in cron parser plus whatever was registered. */
export function resolveRecurrences (recurrences?: types.RecurrenceParsers): Map<string, types.RecurrenceParser> {
  return new Map<string, types.RecurrenceParser>([
    [CRON_KIND, cronRecurrence],
    ...Object.entries(recurrences || {})
  ])
}

/**
 * Calls a parser and insists on a usable answer.
 *
 * A parser is third-party code running inside the cron pass, so its result is checked rather than
 * trusted: a non-Date is a bug that would otherwise reach the schedule table as `Invalid Date`, and
 * an occurrence at or before `after` would spin the catch-up loop forever. `null` is the one
 * legitimate non-Date, meaning the recurrence has no further occurrence.
 */
export function nextOccurrence (
  parser: types.RecurrenceParser,
  expression: string,
  after: Date,
  tz: string
): Date | null {
  const result = parser.next(expression, after, tz)

  if (result === null || result === undefined) {
    return null
  }

  if (!(result instanceof Date) || Number.isNaN(result.getTime())) {
    throw new Error(`recurrence parser returned ${JSON.stringify(String(result))} instead of a Date or null`)
  }

  if (result.getTime() <= after.getTime()) {
    throw new Error(`recurrence parser returned ${result.toISOString()}, which is not after ${after.toISOString()}`)
  }

  return result
}
