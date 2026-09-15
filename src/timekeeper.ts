import { CronExpressionParser } from 'cron-parser'
import assert from 'node:assert'
import EventEmitter from 'node:events'

import * as Attorney from './attorney.ts'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import { isRrule, latestOccurrenceBefore, occurrencesInWindow, rruleWalker, assertRrule, assertRruleSends } from './rrule.ts'
import { assertTimezone } from './timezone.ts'
import { delay } from './tools.ts'
import * as types from './types.ts'
import { emitAndPersistWarning, type WarningContext } from './warning.ts'

export const QUEUES = {
  SEND_IT: '__pgboss__send-it'
}

const EVENTS = {
  error: 'error',
  schedule: 'schedule',
  warning: 'warning'
}

const WARNINGS = {
  CLOCK_SKEW: {
    message: 'Warning: Clock skew between this instance and the database server. This will not break scheduling, but is emitted any time the skew exceeds 60 seconds.'
  }
}

const WARNING_TYPES = {
  CLOCK_SKEW: 'clock_skew',
  INVALID_SCHEDULE: 'invalid_schedule'
} as const

// previewSchedule() defaults and ceilings. The count ceiling is not a database limit, since the walk
// is pure cron-parser arithmetic, but an unbounded count on a per-second expression is a foot-gun.
// A caller that genuinely wants more can page by passing the last occurrence back as `from`.
const PREVIEW_DEFAULT_COUNT = 5

/** Exported so a caller building a form or an HTTP parameter around the ceiling reads it here. */
export const PREVIEW_MAX_COUNT = 1000

// Count is the wrong budget on its own, because occurrences are not equally priced: 1000 of a
// per-second expression cost about 8ms, 1000 of '0 0 1 1 *' about 160ms, and 1000 of '0 0 29 2 *'
// about 6 seconds, since each next() on a sparse expression searches years of candidate dates. The
// walk is synchronous, so those 6 seconds are 6 seconds of blocked event loop for every worker
// poll, cron tick and heartbeat in the process. Bounding wall clock as well caps that at a second
// while leaving the full documented count reachable for any expression that is not pathological.
const PREVIEW_TIME_BUDGET_MS = 1000

// What the cron pass puts on the send-it queue. `key` identifies the schedule row the occurrence
// came from, so the handler can record the job it produced. `slot` is the throttle slot that
// occurrence was filed in, which is how the handler tells a catch-up run from the due one it can
// arrive beside and records the later of the two. Both are absent on rows written by an instance
// older than 12.31.0, and `slot` is absent on a cron occurrence in the due window, which the insert
// files from its own clock, so the handler treats them as optional rather than required.
type ScheduledRequest = types.Request & { key?: string, slot?: string }

// One schedule occurrence that produced a job, as handed to plans.setScheduleLastJobIds. camelCase
// to match the recordset column list the plan quotes, which is how every other JSON payload crossing
// into SQL is shaped.
type FiredSchedule = { name: string, key: string, jobId: string }

// How long an occurrence stays due, and the width of the throttle slot a forwarded job is filed in.
// One value because the two have to agree: a window wider than the slot lets two slots claim the
// same occurrence and send it twice, and a slot wider than the window collapses two occurrences a
// window apart into one job.
const OCCURRENCE_WINDOW_SECONDS = 60

/** The policy names, for the check schedule() performs and the one the pass performs. */
const MISSED_POLICIES = Object.values(plans.SCHEDULE_MISSED_POLICIES)

// __singletonSlot is an internal field of the pass's own insert rather than a documented send
// option, so the forwarded job widens JobInsert here rather than the type widening for everyone.
// A public insert() neither declares the column in the statement it builds nor keeps the field on
// the objects it is handed, so naming it there sets nothing. The pass asks for it with the
// __singletonSlots option it passes beside the jobs.
type ForwardedJob = types.JobInsert & { __singletonSlot?: string }

/**
 * The singleton key a forwarded occurrence is filed under, which is what keeps two instances
 * sending the same occurrence from creating two jobs.
 *
 * The name's own underscores are escaped rather than the pair concatenated raw: underscores are
 * legal in both halves, so `${name}__${key}` collapsed ('report_', 'daily') and ('report', '_daily')
 * onto one key and the 60-second singleton then dropped whichever occurrence lost the race. With
 * the name escaped the first unescaped underscore can only be the separator, so the pair is
 * recoverable from the string, and `\` is outside the charset assertObjectName and assertKey allow
 * on either half, so the escape cannot collide with a name that contains one.
 *
 * A JSON pair would be injective too, and different from the key every release before this one
 * wrote for every schedule there is. The two formats do not collide with each other, so a rolling
 * upgrade would put an old pass and a new pass on the same occurrence and both jobs would survive
 * the singleton. This form is byte-identical to the old key for every name that carries no
 * underscore, so the only keys that move are the ones already colliding today.
 */
function occurrenceKey (name: string, key: string): string {
  return `${name.replaceAll('_', '\\_')}__${key}`
}

/** What a schedule has come due for, and the format its expression was read in to find out. */
type DueOccurrences = { kind: types.ScheduleKind, occurrences: Date[] }

/**
 * The throttle slot an instant falls in, as the timestamp the insert files a job under.
 *
 * `singleton_on` is a timestamp without a zone holding UTC wall time, which is what the insert's own
 * slot expression computes from `now()` for a cron occurrence, so a slot measured here is rendered
 * in the same terms.
 */
function throttleSlot (instant: Date): string {
  const width = OCCURRENCE_WINDOW_SECONDS * 1000

  return new Date(Math.floor(instant.getTime() / width) * width).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * A timestamp column as the driver in front of this instance hands it back: node-postgres parses
 * one into a Date, and an adapter over a backend that speaks JSON hands back the string it was
 * sent. Null for anything that is neither, which is what an absent column reads as.
 */
function toTime (value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime()
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const time = new Date(value).getTime()

    return Number.isNaN(time) ? null : time
  }

  return null
}

/**
 * The catch-up policy a schedule row asks for, which is `skip` for every schedule written before
 * the option existed: a pass sends what the due window holds and nothing else.
 *
 * A value schedule() would have refused can still be on a row, written into the table with SQL or
 * by a release that names a policy this one does not, and reads as `skip` as well. The pass sends
 * what it has always sent rather than picking one of the other two on the row's behalf.
 */
function missedPolicy (options: types.ScheduleOptions | undefined): types.ScheduleMissedPolicy {
  const missed = options?.missed

  return missed !== undefined && MISSED_POLICIES.includes(missed)
    ? missed
    : plans.SCHEDULE_MISSED_POLICIES.skip
}

/**
 * Rejects a catch-up policy no pass would honor, at the one point a caller can be told about it: a
 * value the pass does not recognize reads as `skip`, so a typo left unchecked here is a schedule
 * that silently never catches up on anything.
 */
function assertMissedPolicy (missed: unknown): void {
  // Nullish is "no policy named", which is the default, for the same reason a falsy `tz` is UTC: a
  // value threaded out of a config object or a database column arrives as null rather than absent,
  // and a policy name is never falsy, so nothing a caller could have meant is being read past. The
  // row keeps whatever it was given, and the pass reads it as `skip` either way.
  assert(missed === undefined || missed === null || MISSED_POLICIES.includes(missed as types.ScheduleMissedPolicy),
    `missed must be one of: ${MISSED_POLICIES.join(', ')}`)
}

/**
 * Parses a cron expression the way the cron pass will evaluate it, mapping cron-parser's failures
 * onto messages that name the input actually at fault. Deliberately reuses cron-parser rather than
 * an independent Intl check, so what schedule() accepts is exactly what the cron pass can evaluate.
 *
 * The expression is checked first, against UTC, so a bad expression reports as one rather than as a
 * time zone problem. That first parse tolerates any zone only because cron-parser validates `tz`
 * lazily: with no reference date it never constructs a CronDate, so a typo like 'America/New_Yrok'
 * survives it. assertTimezone forces that construction and names the zone, which is also what the
 * rrule path judges its zone with, so the two report an unusable one in the same words.
 *
 * The returned interval is the one the caller wants anyway, so the walk costs a single parse.
 */
function parseRecurrence (cron: string, tz: string, currentDate: Date) {
  CronExpressionParser.parse(cron, { tz: 'UTC', strict: false })

  assertTimezone(tz)

  return CronExpressionParser.parse(cron, { tz, strict: false, currentDate })
}

/**
 * Validates a recurrence in whichever of the two formats it is written, so previewSchedule() and
 * schedule() reject exactly the same expressions.
 */
function assertRecurrence (expression: string, tz: string, now: Date): void {
  if (isRrule(expression)) {
    assertRrule(expression, tz)
  } else {
    parseRecurrence(expression, tz, now)
  }
}

class Timekeeper extends EventEmitter implements types.EventsMixin {
  db: types.IDatabase
  config: types.ResolvedConstructorOptions
  manager: Manager

  private stopped = true
  private cronMonitorInterval: types.ClockTimer | null | undefined
  private skewMonitorInterval: types.ClockTimer | null | undefined
  private timekeeping: boolean | undefined
  private _checkingSkew = false

  // Rows already warned about, keyed on (name, key, cron, timezone). Unlike every other warning
  // type, an unusable schedule never heals on its own: clock skew converges, a backlog drains, a
  // slow query is a one-off, but a bad row sits there until a human edits it. Warning every pass
  // would persist a row every cronMonitorIntervalSeconds forever, and warningRetentionDays has no
  // default, so a single typo could grow the warning table without bound. Rebuilt each pass from
  // the rows still broken, so a fixed or deleted schedule drops out and would warn again if it
  // came back.
  private warnedSchedules = new Set<string>()

  clockSkew = 0
  events = EVENTS

  constructor (db: types.IDatabase, manager: Manager, config: types.ResolvedConstructorOptions) {
    super()

    this.db = db
    this.config = config
    this.manager = manager
  }

  get checkingSkew (): boolean {
    return this._checkingSkew
  }

  // The instance's reading of the database clock. previewSchedule() promises the reference point the
  // cron pass evaluates against, so both read it here rather than each repeating the arithmetic.
  // Zero skew until cacheClockSkew() has run, which start() only reaches when the instance was
  // configured with scheduling enabled.
  private get databaseTime (): number {
    return this.config.clock.now() + this.clockSkew
  }

  private get warningContext (): WarningContext {
    return {
      emitter: this,
      db: this.db,
      schema: this.config.schema,
      persistWarnings: this.config.persistWarnings,
      warningEvent: this.events.warning,
      errorEvent: this.events.error
    }
  }

  async start () {
    this.stopped = false
    // A restart should re-surface a row nobody has fixed yet
    this.warnedSchedules.clear()

    await this.cacheClockSkew()
    await this.manager.createQueue(QUEUES.SEND_IT)

    const options = {
      pollingIntervalSeconds: this.config.cronWorkerIntervalSeconds,
      batchSize: 50
    }

    await this.manager.work<ScheduledRequest>(QUEUES.SEND_IT, options, (jobs) => this.onSendIt(jobs))

    setImmediate(() => this.onCron())

    this.cronMonitorInterval = this.config.clock.setInterval(async () => await this.onCron(), this.config.cronMonitorIntervalSeconds! * 1000)
    this.skewMonitorInterval = this.config.clock.setInterval(async () => await this.cacheClockSkew(), this.config.clockMonitorIntervalSeconds! * 1000)
  }

  async stop () {
    if (this.stopped) {
      return
    }

    this.stopped = true

    await this.manager.offWork(QUEUES.SEND_IT, { wait: true })

    if (this.skewMonitorInterval) {
      this.config.clock.clearInterval(this.skewMonitorInterval)
      this.skewMonitorInterval = null
    }

    if (this.cronMonitorInterval) {
      this.config.clock.clearInterval(this.cronMonitorInterval)
      this.cronMonitorInterval = null
    }

    while (this.timekeeping || this._checkingSkew) {
      await delay(10)
    }
  }

  async cacheClockSkew () {
    let skew = 0

    this._checkingSkew = true

    try {
      if (this.config.__test__force_clock_monitoring_error) {
        throw new Error(this.config.__test__force_clock_monitoring_error)
      }

      if (this.config.__test__delay_clock_skew_ms) {
        await delay(this.config.__test__delay_clock_skew_ms)
      }

      const { rows } = await this.db.executeSql(plans.getTime(this.config.schema))

      const local = this.config.clock.now()

      const dbTime = parseFloat(rows[0].time)

      skew = dbTime - local

      const skewSeconds = Math.abs(skew) / 1000

      if (skewSeconds >= 60 || this.config.__test__force_clock_skew_warning) {
        await emitAndPersistWarning(
          this.warningContext,
          WARNING_TYPES.CLOCK_SKEW,
          WARNINGS.CLOCK_SKEW.message,
          { seconds: skewSeconds, direction: skew > 0 ? 'slower' : 'faster' }
        )
      }

      this.clockSkew = skew
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      this._checkingSkew = false
    }
  }

  async onCron () {
    try {
      if (this.stopped || this.timekeeping) return

      if (this.config.__test__force_cron_monitoring_error) {
        throw new Error(this.config.__test__force_cron_monitoring_error)
      }

      this.timekeeping = true

      const sql = plans.trySetCronTime(this.config.schema, this.config.cronMonitorIntervalSeconds)

      if (!this.stopped) {
        const { rows } = await this.db.executeSql(sql)

        if (!this.stopped && rows.length === 1) {
          // The claim answers with the timestamp it replaced, which is when an instance last ran a
          // pass. Anything older than the due window between then and now is a gap no pass covered,
          // and a schedule's `missed` policy decides what it owes for it.
          await this.cron(rows[0].priorCronOn)
        }
      }
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      this.timekeeping = false
    }
  }

  /**
   * `priorCronOn` is when an instance last ran a pass, as the claim in onCron() read it off the row
   * it advanced. Null on a database no pass has run against, and left null by a caller that does
   * not know: either way no schedule has a gap to catch up on and the pass sends the due window,
   * which is what every release before catch-up sent.
   */
  async cron (priorCronOn: unknown = null) {
    const schedules = await this.getSchedules()

    const scheduled: ForwardedJob[] = []
    const stillBroken = new Set<string>()

    // Rows whose stored kind disagrees with the expression on them, as found out by reading the
    // expression the other way. Relabelled once the pass has sent what it owes, and each carries
    // the expression the label was read off, since a schedule() upsert landing between this pass's
    // read and its write would otherwise be stamped with the previous expression's kind.
    const relabelled: Array<Pick<types.Schedule, 'name' | 'key' | 'kind' | 'cron'>> = []

    // One instant for the whole pass, so every schedule is judged against the same clock and the
    // throttle slot of a forwarded job is measured from the same place its occurrence was.
    const databaseTime = this.databaseTime

    // Where the due window opens, and with it where a gap ends: an occurrence inside the window is
    // due now, and one older than it came due while nothing was looking.
    const windowStart = databaseTime - OCCURRENCE_WINDOW_SECONDS * 1000

    const lastPass = toTime(priorCronOn)

    for (const schedule of schedules) {
      const { name, key, data, options, kind, cron, timezone } = schedule

      // Reports a row the pass could not read, once per (name, key, expression, zone) rather than
      // once per pass: an unusable schedule never heals on its own, so warning every pass would
      // persist a row every cronMonitorIntervalSeconds forever.
      const warned = JSON.stringify([name, key, cron, timezone])

      const warn = async (message: string) => {
        stillBroken.add(warned)

        if (!this.warnedSchedules.has(warned)) {
          await emitAndPersistWarning(this.warningContext, WARNING_TYPES.INVALID_SCHEDULE, message, { queue: name, key, cron, timezone })
        }
      }

      let due: DueOccurrences

      try {
        due = this.dueOccurrences(cron, kind, timezone, databaseTime)
      } catch (err) {
        // Evaluating one row must not decide the fate of the others. schedule() now rejects an
        // unusable time zone, but a row written by an earlier release, or straight into the table,
        // still throws here. This was a single filter() over every schedule, so one such row
        // propagated out of cron() and silently stopped scheduling for every queue in the
        // deployment, on every pass, until someone found the row. Skip it and warn instead, naming
        // the schedule so it is actually fixable.
        await warn(`Warning: schedule for queue "${name}" (key "${key}") could not be evaluated and was skipped: ${(err as Error).message}`)

        continue
      }

      let missed: Date | null = null

      try {
        missed = this.missedOccurrence(schedule, due.kind, lastPass, windowStart)
      } catch (err) {
        // Its own try, so a catch-up that cannot be read does not cost the occurrence that is due
        // now. The two reads are hard to make diverge: the backwards one narrows its steps until
        // they are no wider than an hour, and an expression rrule-temporal refuses at an hour it
        // refuses over a minute too, which the read above catches and skips the whole row for. They
        // stay split anyway, because sharing the try was a real defect once and nothing about two
        // separate calls over different ranges makes it safe to couple them again. If a catch-up
        // does fail on its own the gap still closes, since the claim has already moved, so the
        // occurrence is gone rather than deferred and the operator is told.
        await warn(`Warning: schedule for queue "${name}" (key "${key}") could not be caught up on the gap since the last cron pass: ${(err as Error).message}`)
      }

      if (due.kind !== kind) {
        relabelled.push({ name, key, kind: due.kind, cron })
      }

      // The payload carries the schedule's key beside its queue name, so the send-it handler knows
      // which row an occurrence came from and can record the job it produced.
      const forwarded = { data: { name, key, data, options }, singletonKey: occurrenceKey(name, key) }

      // A recurrence rule can put an occurrence anywhere in the minute, and a slot measured from
      // insert time would then straddle it: two passes on either side of a slot boundary both find
      // the occurrence inside the window and file it in a slot of their own, sending it twice. So a
      // rule occurrence names the slot it falls in outright. An offset from the insert's own now()
      // would not pin it: everything between reading the clock here and the insert committing
      // counts towards the shifted instant, which lands in the next slot whenever that adds up to a
      // boundary crossing.
      //
      // A missed occurrence names its slot for that reason and one more: it is older than the
      // window, so a slot off insert time would file it in the slot the pass runs in, where it
      // would collide with the cron job filed below and be dropped. The slot it names is older
      // than the one insert time computes, so it cannot.
      //
      // One job per slot rather than one per occurrence, which is the resolution the docs promise:
      // a rule finer than a slot sends a job a slot, and two occurrences inside one window that
      // fall in slots of their own each send.
      const slots = new Set<string>()

      if (missed !== null) {
        slots.add(throttleSlot(missed))
      }

      if (due.kind === plans.SCHEDULE_KINDS.rrule) {
        // Through the set the missed occurrences went through, since the window's lower bound falls
        // inside a slot rather than on one: an occurrence on the bound is missed, one a millisecond
        // later is due, and both belong to the same slot and so to the same job.
        for (const occurrence of due.occurrences) {
          slots.add(throttleSlot(occurrence))
        }
      }

      for (const slot of slots) {
        scheduled.push({ ...forwarded, data: { ...forwarded.data, slot }, __singletonSlot: slot })
      }

      // Anything not read as a rule is read as cron, which is what a row carrying no kind at all
      // means: the column defaults to cron, and a reader that cannot see it reads the row the way
      // every release before the column did.
      if (due.kind !== plans.SCHEDULE_KINDS.rrule && due.occurrences.length > 0) {
        // A cron occurrence keeps the slot every release has always filed it in, since an instance
        // still running an older one during a rolling upgrade computes that slot and nothing else,
        // and a slot the two disagree on collapses nothing.
        scheduled.push({ ...forwarded, singletonSeconds: OCCURRENCE_WINDOW_SECONDS })
      }
    }

    this.warnedSchedules = stillBroken

    if (scheduled.length > 0 && !this.stopped) {
      await this.manager.insert(QUEUES.SEND_IT, scheduled, { __singletonSlots: true })
    }

    // After the sends, so a failed relabel cannot cost an occurrence. Nothing depends on the write:
    // the fallback in dueOccurrences fires the row either way. What it buys is getSchedules() no
    // longer reporting a format the expression is not in, and the row leaving that fallback path.
    if (relabelled.length > 0 && !this.stopped) {
      await this.db.executeSql(plans.setScheduleKinds(this.config.schema), [JSON.stringify(relabelled)])
    }
  }

  shouldSendIt (expression: string, tz: string, kind: types.ScheduleKind = plans.SCHEDULE_KINDS.cron) {
    return this.dueOccurrences(expression, kind, tz).occurrences.length > 0
  }

  /**
   * The occurrences a schedule has come due for, and the format they were read in.
   *
   * `kind` says how to read the expression, and comes off the schedule row: the format was settled
   * when the schedule was written, so a pass reads the expression the one way its author meant it
   * rather than guessing again every 30 seconds.
   *
   * The column is a hint rather than a verdict, though, because two ordinary upgrade paths leave it
   * disagreeing with the expression beside it. A 12.30.x instance's `schedule()` does not name the
   * column, so an upsert from one during a rolling upgrade replaces the expression and leaves
   * whatever kind a newer instance last wrote; a v41 rollback drops the column, and the re-upgrade
   * labels every row from its default. Either way the row reads fine and never fires again. So when
   * an expression cannot be read the way the column says, and is written the other way, it is read
   * the way it is written: one regex, on a path that was already about to give up.
   */
  private dueOccurrences (expression: string, kind: types.ScheduleKind, tz: string, databaseTime = this.databaseTime): DueOccurrences {
    try {
      return { kind, occurrences: this.readOccurrences(expression, kind, tz, databaseTime) }
    } catch (err) {
      const detected: types.ScheduleKind = isRrule(expression) ? plans.SCHEDULE_KINDS.rrule : plans.SCHEDULE_KINDS.cron

      // The column and the expression agree, so the expression itself is what is wrong with the row,
      // and the caller names it in a warning.
      if (detected === kind) {
        throw err
      }

      return { kind: detected, occurrences: this.readOccurrences(expression, detected, tz, databaseTime) }
    }
  }

  /**
   * The occurrence a schedule owes a job for from the gap since the last pass, or null when it owes
   * none. Null for every schedule under the default policy, and for every schedule at all in a
   * deployment whose passes keep running.
   *
   * The gap is (lastPass, windowStart]: older than the due window, so no pass has sent it, and
   * newer than the moment an instance last ran a pass, so no pass has skipped it either. A pass
   * claims at most `cronMonitorIntervalSeconds` after the one before it, 45 seconds at the
   * configurable ceiling, against a 60-second window, so the range is empty while passes keep
   * running and fills up when they stop: a deployment that is down, between deploys, or running
   * with scheduling switched off.
   *
   * The most recent occurrence rather than all of them, which is the whole of what `once` promises:
   * a job carries the schedule's `data` and nothing else, so a job per missed occurrence would be
   * twelve identical jobs after a twelve-hour outage with no way for a handler to tell which hour
   * each was for. One job whose meaning is "catch up to now" needs no such identity.
   *
   * Bounded below by the row's own `created_on` as well, so a schedule written during the gap does
   * not start life owing an occurrence of an expression that was not in the table yet. Not by
   * `updated_on`, which a deployment calling schedule() on every boot rewrites on the way up: that
   * would leave the policy with nothing to catch up on in precisely the case it exists for.
   */
  private missedOccurrence (schedule: types.Schedule, kind: types.ScheduleKind, lastPass: number | null, windowStart: number): Date | null {
    const { cron, timezone, options, createdOn } = schedule

    if (missedPolicy(options) === plans.SCHEDULE_MISSED_POLICIES.skip || lastPass === null) {
      return null
    }

    const from = Math.max(lastPass, toTime(createdOn) ?? lastPass)

    if (from >= windowStart) {
      return null
    }

    return this.latestOccurrenceBefore(cron, kind, timezone, new Date(from), new Date(windowStart))
  }

  /**
   * The most recent occurrence an expression produces in (after, until], read as `kind` says to
   * read it, or null when the range holds none.
   *
   * Backwards from the window rather than forwards from the gap's start: the range is as wide as
   * the outage it covers, the read is synchronous like the rest of the pass, and what it costs has
   * to follow the one job it will send rather than the length of the outage.
   */
  private latestOccurrenceBefore (expression: string, kind: types.ScheduleKind, tz: string, after: Date, until: Date): Date | null {
    if (kind === plans.SCHEDULE_KINDS.rrule) {
      return latestOccurrenceBefore(expression, after, until, tz)
    }

    // cron-parser's prev() answers strictly before its reference date, so the reference is a
    // millisecond past `until` to leave the upper bound included. That is where the due window's
    // own lower bound leaves off, and an occurrence exactly on it belongs to one range or the
    // other, never both.
    const interval = CronExpressionParser.parse(expression, { tz, strict: false, currentDate: new Date(until.getTime() + 1) })

    const occurrence = interval.prev().toDate()

    return occurrence.getTime() > after.getTime() ? occurrence : null
  }

  /**
   * Every occurrence of an expression inside the due window, read as `kind` says to read it.
   *
   * Due means "an occurrence in the last minute", whatever the pass interval: a pass runs every
   * `cronMonitorIntervalSeconds` (30 by default), so the window has to be wide enough that an
   * occurrence is still due when the next pass reaches it, and the throttle slot of the forwarded
   * job is what keeps the passes that follow from sending it a second time.
   *
   * The window rather than its most recent point, since a rule can put two occurrences inside it
   * and a read that answers with one of them drops the other. A cron expression cannot: its finest
   * resolution is a second, and consecutive occurrences a second apart share a throttle slot, so
   * only the most recent one can produce a job.
   */
  private readOccurrences (expression: string, kind: types.ScheduleKind, tz: string, databaseTime: number): Date[] {
    const window = new Date(databaseTime - OCCURRENCE_WINDOW_SECONDS * 1000)

    if (kind === plans.SCHEDULE_KINDS.rrule) {
      return occurrencesInWindow(expression, window, new Date(databaseTime), tz)
    }

    const interval = CronExpressionParser.parse(expression, { tz, strict: false, currentDate: new Date(databaseTime) })

    const previous = interval.prev().toDate()

    return previous.getTime() > window.getTime() ? [previous] : []
  }

  // Reports a problem the send-it handler must survive. Node treats an `error` event with no
  // listener as a throw, and index.ts re-promotes this one onto the PgBoss instance, so a plain
  // emit() here could escape the handler, fail the send-it job and replay the whole batch, sending
  // every occurrence in it a second time.
  private reportSendItError (err: unknown): void {
    try {
      this.emit(this.events.error, err)
    } catch {
      // nothing left to report it to
    }
  }

  private async onSendIt (jobs: types.Job<ScheduledRequest>[]): Promise<void> {
    // async so a malformed payload rejects its own settlement rather than throwing synchronously
    // out of map() and taking the whole batch with it
    const results = await Promise.allSettled(jobs.map(async ({ data }) => {
      // key and slot are the pass's own bookkeeping, read below rather than sent: send() takes the
      // request the schedule row described and nothing else.
      const { key, slot, ...request } = data
      return await this.manager.send(request)
    }))

    // Keyed on (name, key) so a batch holding more than one occurrence of the same schedule
    // resolves to its latest. Feeding several to the UPDATE would let postgres pick any of the
    // source rows, and last_job_id could end up naming an older job. A batch holds more than one
    // whenever it spans two minute buckets, and a pass catching a schedule up puts two in at once,
    // the missed occurrence and the one due now, which the fetch hands over in no particular order:
    // the slot each occurrence was filed in is what orders them here.
    const fired = new Map<string, { record: FiredSchedule, slot: string }>()

    // Surface any failed forward so a lost cron tick isn't silent
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.reportSendItError(result.reason)
        continue
      }

      const { name, key, slot } = jobs[index].data

      // send() resolves null when a throttle or queue policy dropped the job, so there is nothing
      // to point last_job_id at. `key` is absent on a payload written by an older instance.
      if (result.value === null || key === undefined) {
        continue
      }

      const id = JSON.stringify([name, key])

      // A cron occurrence in the due window names no slot, since the insert files it from its own
      // clock. That slot is the one the pass is running in, which is later than every slot a
      // catch-up occurrence can name, so the current one stands in for it.
      const filed = slot ?? throttleSlot(new Date(this.databaseTime))

      const latest = fired.get(id)

      if (latest === undefined || latest.slot <= filed) {
        fired.set(id, { record: { name, key, jobId: result.value }, slot: filed })
      }
    }

    if (fired.size > 0) {
      await this.setLastJobIds([...fired.values()].map(({ record }) => record))
    }
  }

  // Best effort: the schedule fired and the job exists, so failing to annotate the schedule row
  // must not fail the send-it job and replay the occurrence. Reported through `error` instead.
  private async setLastJobIds (fired: FiredSchedule[]): Promise<void> {
    try {
      const sql = plans.setScheduleLastJobIds(this.config.schema)
      await this.db.executeSql(sql, [JSON.stringify(fired)])
    } catch (err) {
      // Named, because a bare driver error here is indistinguishable from the forwarding failures
      // emitted above, and the two call for different responses: this one leaves the jobs created
      // and only the bookkeeping behind.
      const schedules = fired.map(({ name, key }) => `"${name}" (key "${key}")`).join(', ')
      const message = `Warning: schedules fired but their last job id could not be recorded for ${schedules}: ${(err as Error).message}`

      this.reportSendItError(new Error(message, { cause: err }))
    }
  }

  async getSchedules (name?: string, key?: string): Promise<types.Schedule[]> {
    let sql = plans.getSchedules(this.config.schema)
    let params: unknown[] = []

    if (name && key !== undefined) {
      sql = plans.getSchedulesByQueueAndKey(this.config.schema)
      params = [name, key]
    } else if (name) {
      sql = plans.getSchedulesByQueue(this.config.schema)
      params = [name]
    }

    const { rows } = await this.db.executeSql(sql, params)

    return rows
  }

  async getSchedule (name: string, key = ''): Promise<types.Schedule | null> {
    // Only that a name is present, and only because getSchedules() reads a falsy one as "every
    // schedule" and would hand back an arbitrary row as though it belonged to this key. Neither the
    // name nor the key is checked against the rules schedule() enforces on the way in: a value
    // those rules reject cannot have a row either, so `null` is the honest answer, and this stays a
    // drop-in for the `const [schedule] = await getSchedules(name, key)` it replaces rather than
    // throwing where that returns nothing.
    assert(name, 'Name is required')
    assert(typeof name === 'string', 'Name must be a string')

    const [schedule] = await this.getSchedules(name, key)

    return schedule ?? null
  }

  /**
   * A walk of an expression's occurrences after `from`, one call at a time, answering null once a
   * finite rule has run out.
   *
   * Validating is part of it, since neither format can be walked without being parsed: cron-parser
   * carries its own cursor from the reference date it was built with, and a rule is asked for the
   * occurrence after the last one handed back.
   */
  private occurrenceWalker (expression: string, tz: string, from: Date): () => Date | null {
    if (isRrule(expression)) {
      assertRrule(expression, tz)

      return rruleWalker(expression, tz, from)
    }

    const interval = parseRecurrence(expression, tz, from)

    return () => interval.next().toDate()
  }

  /**
   * The occurrences an expression produces, in either format, computed in process without touching
   * the database or the schedule table.
   *
   * `from` defaults to database time: this instance's clock plus the skew cached against the
   * database, the same reading the cron pass evaluates against, so a preview taken from an instance
   * that runs schedules lines up with what that instance will send. Skew is cached by the
   * timekeeper, which start() only runs when the instance was configured with scheduling enabled,
   * so anywhere else (a never-started instance, or the proxy, which defaults `schedule` to false)
   * it is zero and the default is this process's plain local clock. Pass `from` to be certain.
   *
   * Occurrences are strictly after `from`, so paging is a matter of passing the last one back in.
   *
   * The result describes the expression, not the delivery. The cron pass runs every
   * `cronMonitorIntervalSeconds` and matches an occurrence within the preceding 60 seconds, so a
   * job lands at or shortly after each listed time.
   */
  previewSchedule (cron: string, options: types.PreviewScheduleOptions = {}): Date[] {
    const { count = PREVIEW_DEFAULT_COUNT } = options

    // Falsy is UTC here for the reason it is in schedule(), and for one more: the documented recipe
    // for previewing a stored schedule passes `schedule.timezone` straight in, and that column is
    // nullable, so a row written before schedule() validated zones would otherwise throw on the
    // read path rather than preview the zone the pass evaluates it in.
    const tz = options.tz || 'UTC'

    const from = options.from ?? new Date(this.databaseTime)

    assert(from instanceof Date && !Number.isNaN(from.getTime()), 'from must be a valid Date')

    // The expression before the count, so an out-of-range count cannot mask an expression that
    // could never be stored. `from` has to precede both: the walk reads it.
    const next = this.occurrenceWalker(cron, tz, from)

    assert(Number.isInteger(count) && count >= 1 && count <= PREVIEW_MAX_COUNT,
      `count must be an integer between 1 and ${PREVIEW_MAX_COUNT}`)

    const deadline = Date.now() + PREVIEW_TIME_BUDGET_MS
    const occurrences: Date[] = []

    while (occurrences.length < count) {
      const occurrence = next()

      // A finite rule runs out, and a list shorter than `count` is the honest answer for one that
      // has. schedule() is where a rule with nothing left to send is refused instead.
      if (occurrence === null) {
        break
      }

      occurrences.push(occurrence)

      if (occurrences.length < count && Date.now() > deadline) {
        throw new Error(`Gave up after ${PREVIEW_TIME_BUDGET_MS}ms with ${occurrences.length} of ${count} occurrences of "${cron}". Ask for fewer and page with \`from\`.`)
      }
    }

    return occurrences
  }

  async schedule (name: string, cron: string, data?: unknown, options: types.ScheduleOptions = {}): Promise<void> {
    // `missed` comes out with tz and key: it tells the pass what to do about a gap and is no more a
    // send option than they are, so the send-option check below is not handed it.
    const { tz: requestedTz, key = '', missed, ...rest } = options

    // Any falsy zone is "none specified", not a zone to be judged: a destructuring default only
    // covers `undefined`, and a value threaded out of a config object or read back off the nullable
    // timezone column arrives as null. Coalescing it here is what keeps the two engines from
    // disagreeing about what it meant, since cron-parser reads a non-string zone as unset and
    // evaluates in the host's local zone while rrule-temporal refuses it outright. A truthy zone
    // the parser rejects still throws.
    const tz = requestedTz || 'UTC'

    // The one place the format of an expression is decided. Every reader takes it from the stored
    // kind instead, so a schedule cannot be validated as one format and later evaluated as the
    // other, and a row can say what it is without anyone parsing it.
    const kind: types.ScheduleKind = isRrule(cron) ? plans.SCHEDULE_KINDS.rrule : plans.SCHEDULE_KINDS.cron

    assertRecurrence(cron, tz, new Date(this.config.clock.now()))

    // A rule, unlike a cron expression, can have nothing left to send, which is the one failure a
    // caller cannot see: the row sits in the table, every pass evaluates it, and no job is ever
    // sent. Judged from the database's clock, since that is the one the pass reads, so a rule
    // expiring inside the skew window is judged the way it will be evaluated. previewSchedule()
    // makes no such demand, since an empty list is the honest answer for a rule that has finished.
    if (kind === plans.SCHEDULE_KINDS.rrule) {
      assertRruleSends(cron, tz, new Date(this.databaseTime))
    }

    Attorney.checkSendArgs([name, data, { ...rest }])
    Attorney.assertKey(key)
    assertMissedPolicy(missed)

    try {
      const sql = plans.schedule(this.config.schema)
      await this.db.executeSql(sql, [name, key, kind, cron, tz, data, options])
    } catch (err: any) {
      if (err.message.includes('foreign key')) {
        err.message = `Queue ${name} not found`
      }

      throw err
    }
  }

  async unschedule (name: string, key = ''): Promise<void> {
    const sql = plans.unschedule(this.config.schema)
    await this.db.executeSql(sql, [name, key])
  }
}

export default Timekeeper
