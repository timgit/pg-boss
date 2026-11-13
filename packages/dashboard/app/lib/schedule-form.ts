/**
 * The new schedule form, read into what `boss.schedule()` is asked for. Pure, so the rules are
 * testable without a router or a database. Empty fields are left out, so pg-boss applies its own
 * defaults.
 */

export type ScheduleOptions = Record<string, unknown>

export interface ScheduleRequest { queue: string, cron: string, data: object | null, options?: ScheduleOptions }

export type ParsedSchedule = { error: string } | { value: ScheduleRequest }

type Rule = 'any' | 'nonNegative' | 'positive'

const INTEGERS: Array<[name: string, label: string, rule: Rule]> = [
  ['priority', 'Priority', 'any'],
  ['retryLimit', 'Retry limit', 'nonNegative'],
  ['expireInSeconds', 'Expire in seconds', 'positive'],
]

const KIND: Record<Rule, string> = { any: 'an integer', nonNegative: 'a non-negative integer', positive: 'a positive integer' }

// What the core uses to tell a recurrence rule from cron (src/rrule.ts): an iCalendar property at the
// head of a line, or the FREQ part every rule carries, neither of which a cron field can contain. A
// rule is left to the core to validate.
const RECURRENCE_RULE = /^[ \t]*[a-z][a-z0-9-]*[;:]|(?:^|[\s;])FREQ=/im

function field (form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export function parseScheduleForm (form: FormData): ParsedSchedule {
  const queue = field(form, 'queueName')
  if (!queue) return { error: 'Queue name is required' }

  const cron = field(form, 'cron')
  if (!cron) return { error: 'An expression is required' }

  if (!RECURRENCE_RULE.test(cron) && cron.split(/\s+/).length !== 5) {
    return { error: 'A cron expression has 5 parts: minute, hour, day of the month, month and day of the week' }
  }

  let data: object | null = null
  const raw = field(form, 'data')

  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: 'Invalid JSON in data payload' }
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'Data payload must be a JSON object' }
    }

    data = parsed
  }

  const options: ScheduleOptions = {}

  const key = field(form, 'key')
  if (key) options.key = key

  const tz = field(form, 'timezone')
  if (tz) options.tz = tz

  const missed = field(form, 'missed')
  if (missed) {
    if (missed !== 'skip' && missed !== 'once') return { error: 'Missed occurrences must be skip or once' }
    options.missed = missed
  }

  for (const [name, label, rule] of INTEGERS) {
    const value = field(form, name)
    if (!value) continue

    const n = Number(value)
    const ok = Number.isInteger(n) && (rule === 'any' || (rule === 'nonNegative' ? n >= 0 : n > 0))
    if (!ok) return { error: `${label} must be ${KIND[rule]}` }

    options[name] = n
  }

  return { value: { queue, cron, data, options: Object.keys(options).length > 0 ? options : undefined } }
}
