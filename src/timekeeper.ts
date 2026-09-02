import assert from 'node:assert'
import EventEmitter from 'node:events'

import * as Attorney from './attorney.ts'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
import { CRON_KIND, nextOccurrence, resolveRecurrences } from './recurrence.ts'
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
  INVALID_SCHEDULE: 'invalid_schedule',
  UNSUPPORTED_RECURRENCE: 'unsupported_recurrence',
  MISSED_OCCURRENCES_CAPPED: 'missed_occurrences_capped'
} as const

const MISSED_POLICIES: types.MissedPolicy[] = ['skip', 'once', 'all']

// An occurrence claimed within this long of coming due ran on time; anything older was missed while
// no instance was there to claim it, and the schedule's `missed` policy decides its fate. 60 seconds
// is the window cron evaluation used before occurrences were persisted, so `skip` (the default)
// reproduces the old behaviour exactly. A monitor interval slow enough to overrun it widens the
// window rather than dropping occurrences the pass simply hadn't got to yet.
const MISSED_GRACE_SECONDS = 60

// `missed: 'all'` sends one job per missed occurrence, which is unbounded by construction: a minutely
// schedule unattended for a week is ten thousand of them. The remainder is dropped and reported.
const MAX_CATCHUP_OCCURRENCES = 1000

// How long a schedule may sit with no pending occurrence before repair adopts it. Long enough that a
// row mid-claim (claimed and rescheduled milliseconds apart, in the same pass) is never mistaken for
// an abandoned one.
const REPAIR_STALE_SECONDS = 300

/**
 * Normalizes the recurrence argument of schedule(). A bare string is cron, which is what every
 * caller written before kinds existed passes.
 */
function toRecurrence (value: string | types.Recurrence): types.Recurrence {
  if (typeof value === 'string') {
    return { kind: CRON_KIND, expression: value }
  }

  assert(value && typeof value === 'object', 'schedule() requires a cron string or a { kind, expression } object')

  const { kind, expression } = value

  assert(typeof kind === 'string' && kind.length > 0, 'recurrence kind is required')
  assert(typeof expression === 'string' && expression.length > 0, 'recurrence expression is required')

  return { kind, expression }
}

// timestamptz comes back as a Date from the pg driver, but an adapter is free to hand back the raw
// string, and a parser fed a string would compute occurrences from `Invalid Date`.
function toDate (value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string)
}

/** What a claimed occurrence turns into: how many jobs, and when the schedule is next due. */
interface OccurrencePlan {
  sends: number
  nextRunAt: Date | null
  truncated: boolean
}

/** A row returned by the claim, which reports the previous run alongside the occurrence taken. */
interface ClaimRow {
  kind: string
  expression: string
  timezone: string
  options?: types.ScheduleOptions
  priorRunAt: Date | null
}

interface ClaimedOccurrence {
  name: string
  key: string
  dueAt: Date
  plan: OccurrencePlan
}

// Stored options come from the database, so an unrecognized value is possible (an older release, a
// hand-written row) and falls back to the default rather than throwing mid-pass. schedule() rejects
// one outright, which is where a typo should surface.
function resolveMissedPolicy (value: unknown): types.MissedPolicy {
  return MISSED_POLICIES.includes(value as types.MissedPolicy) ? value as types.MissedPolicy : 'skip'
}

class Timekeeper extends EventEmitter implements types.EventsMixin {
  db: types.IDatabase
  config: types.ResolvedConstructorOptions
  manager: Manager

  private stopped = true
  private cronMonitorInterval: NodeJS.Timeout | null | undefined
  private skewMonitorInterval: NodeJS.Timeout | null | undefined
  private timekeeping: boolean | undefined
  private _checkingSkew = false

  // Rows already warned about, keyed on the warning and the row that caused it. Unlike every other
  // warning type, an unusable schedule never heals on its own: clock skew converges, a backlog drains, a
  // slow query is a one-off, but a bad row sits there until a human edits it. Warning every pass
  // would persist a row every cronMonitorIntervalSeconds forever, and warningRetentionDays has no
  // default, so a single typo could grow the warning table without bound. Rebuilt each pass from
  // the rows still broken, so a fixed or deleted schedule drops out and would warn again if it
  // came back.
  private warnedSchedules = new Set<string>()

  // The recurrence kinds this process can evaluate: the built-in cron parser plus anything handed to
  // the constructor. Registered in the process rather than the database, exactly like work()
  // handlers, so a stored kind nobody here understands is left for an instance that does.
  private parsers: Map<string, types.RecurrenceParser>

  clockSkew = 0
  events = EVENTS

  constructor (db: types.IDatabase, manager: Manager, config: types.ResolvedConstructorOptions) {
    super()

    this.db = db
    this.config = config
    this.manager = manager
    this.parsers = resolveRecurrences(config.recurrences)
  }

  private get supportedKinds (): string[] {
    return [...this.parsers.keys()]
  }

  /** Grace period for an occurrence claimed late. See MISSED_GRACE_SECONDS. */
  private get missedGraceSeconds (): number {
    return Math.max(MISSED_GRACE_SECONDS, (this.config.cronMonitorIntervalSeconds || 0) * 2)
  }

  /** Best estimate of the database clock, which is the clock every occurrence is measured against. */
  private databaseNow (): Date {
    return new Date(Date.now() + this.clockSkew)
  }

  get checkingSkew (): boolean {
    return this._checkingSkew
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

    await this.manager.work<types.Request>(QUEUES.SEND_IT, options, (jobs) => this.onSendIt(jobs))

    setImmediate(() => this.onCron())

    this.cronMonitorInterval = setInterval(async () => await this.onCron(), this.config.cronMonitorIntervalSeconds! * 1000)
    this.skewMonitorInterval = setInterval(async () => await this.cacheClockSkew(), this.config.clockMonitorIntervalSeconds! * 1000)
  }

  async stop () {
    if (this.stopped) {
      return
    }

    this.stopped = true

    await this.manager.offWork(QUEUES.SEND_IT, { wait: true })

    if (this.skewMonitorInterval) {
      clearInterval(this.skewMonitorInterval)
      this.skewMonitorInterval = null
    }

    if (this.cronMonitorInterval) {
      clearInterval(this.cronMonitorInterval)
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

      const { rows } = await this.db.executeSql(plans.getTime())

      const local = Date.now()

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
          await this.cron()
        }
      }
    } catch (err) {
      this.emit(this.events.error, err)
    } finally {
      this.timekeeping = false
    }
  }

  /**
   * One scheduling pass: re-anchor schedules with no pending occurrence, claim the occurrences that
   * have come due, report kinds this process cannot evaluate.
   *
   * Repair runs first so a row parked by a dead process (or one carried over from a schema that
   * predates persisted occurrences) is anchored before the claim looks for due work, and so it can
   * never overwrite an occurrence this pass is in the middle of dispatching.
   */
  async cron () {
    // Rebuilt from scratch each pass: a schedule that no longer reports a problem drops out of the
    // suppression set and would warn again if it broke a second time.
    const stillBroken = new Set<string>()

    await this.repairSchedules(stillBroken)
    await this.dispatchSchedules(stillBroken)
    await this.reportUnsupportedKinds(stillBroken)

    this.warnedSchedules = stillBroken
  }

  /**
   * Claims every occurrence that has come due and forwards it to the send-it queue.
   *
   * Cross-instance exclusion is the row claim itself (see plans.claimDueSchedules), which is why the
   * forwarded jobs no longer carry the `singletonSeconds: 60` throttle that used to provide it: that
   * throttle also capped scheduling at one job per minute per schedule, which a sub-minute kind and
   * `missed: 'all'` both need to exceed.
   */
  private async dispatchSchedules (stillBroken: Set<string>) {
    const sql = plans.claimDueSchedules(this.config.schema, this.config.noSkipLocked)

    const { rows } = await this.db.executeSql(sql, [this.supportedKinds])

    if (rows.length === 0) {
      return
    }

    const scheduled: types.JobInsert[] = []
    const claims: ClaimedOccurrence[] = []

    for (const row of rows) {
      const { name, key, kind, expression, timezone, data, options } = row

      const now = row.databaseTime ? toDate(row.databaseTime) : this.databaseNow()
      const dueAt = toDate(row.dueAt)

      let plan: OccurrencePlan

      try {
        plan = this.planOccurrences(row, dueAt, now)
      } catch (err) {
        // One unusable row must not decide the fate of the others: evaluation used to run as a
        // single filter() over every schedule, so one bad expression propagated out of the pass and
        // silently stopped scheduling for every queue in the deployment. The row is left with no
        // pending occurrence, and repair picks it up again once the operator has fixed it.
        await this.warnOnce(stillBroken, [name, key, kind, expression, timezone],
          WARNING_TYPES.INVALID_SCHEDULE,
          `Warning: schedule for queue "${name}" (key "${key}") could not be evaluated and was skipped: ${(err as Error).message}`,
          { queue: name, key, kind, expression, timezone })

        continue
      }

      for (let i = 0; i < plan.sends; i++) {
        scheduled.push({ data: { name, data, options }, singletonKey: `${name}__${key}` })
      }

      claims.push({ name, key, dueAt, plan })

      if (plan.truncated) {
        await this.warnOnce(stillBroken, [name, key, kind, expression, timezone],
          WARNING_TYPES.MISSED_OCCURRENCES_CAPPED,
          `Warning: schedule for queue "${name}" (key "${key}") missed more than ${MAX_CATCHUP_OCCURRENCES} occurrences; the rest were dropped`,
          { queue: name, key, kind, expression, timezone, cap: MAX_CATCHUP_OCCURRENCES })
      }
    }

    // Forwarding happens before the schedules advance, so an occurrence is only ever written off
    // once it is somewhere durable. Until then the row still carries the claim, and handing it back
    // is a single UPDATE away.
    let forwarded = true
    let forwardError: unknown

    if (scheduled.length > 0) {
      if (this.stopped) {
        forwarded = false
      } else {
        try {
          await this.manager.insert(QUEUES.SEND_IT, scheduled)
        } catch (err) {
          forwarded = false
          forwardError = err
        }
      }
    }

    for (const { name, key, dueAt, plan } of claims) {
      // A claim whose jobs never reached the queue goes back exactly as it was, for a later pass to
      // re-claim; `skip` will then judge for itself whether the occurrence is still worth sending.
      // Everything else advances to the occurrence the parser computed.
      const nextRunAt = (!forwarded && plan.sends > 0) ? dueAt : plan.nextRunAt

      await this.setNextRun(name, key, nextRunAt).catch((err) => this.emit(this.events.error, err))
    }

    if (forwardError) {
      throw forwardError
    }
  }

  /**
   * Decides how many jobs a claimed occurrence produces and when the schedule is next due.
   *
   * `dueAt` is the occurrence just claimed, which is the current one only if a pass got to it
   * promptly. Anything older came due while no instance was claiming, so the schedule's `missed`
   * policy applies.
   */
  private planOccurrences (row: ClaimRow, dueAt: Date, now: Date): OccurrencePlan {
    const parser = this.parsers.get(row.kind)!
    const { expression, timezone } = row
    const tz = timezone || 'UTC'
    const missed = resolveMissedPolicy(row.options?.missed)

    if (missed === 'all') {
      let sends = 1
      let cursor = dueAt
      let truncated = false
      let nextRunAt: Date | null = null

      for (;;) {
        nextRunAt = nextOccurrence(parser, expression, cursor, tz)

        if (nextRunAt === null || nextRunAt.getTime() > now.getTime()) {
          break
        }

        if (sends >= MAX_CATCHUP_OCCURRENCES) {
          truncated = true
          nextRunAt = nextOccurrence(parser, expression, now, tz)
          break
        }

        sends++
        cursor = nextRunAt
      }

      return { sends, nextRunAt, truncated }
    }

    // A schedule's first occurrence always sends. schedule() anchors it through the same grace
    // window this check applies, so whether the occurrence that had just passed at insert time
    // counts was already decided there; re-deciding it here against a pass that runs seconds later
    // would drop it for having aged those seconds.
    const onTime = row.priorRunAt === null || row.priorRunAt === undefined ||
      now.getTime() - dueAt.getTime() <= this.missedGraceSeconds * 1000

    // Anchored past the occurrence as well as past now, so a claim that lands fractionally before
    // the occurrence it just took (the clock estimate is an estimate) cannot re-derive that same
    // occurrence and fire it twice.
    const anchor = dueAt.getTime() > now.getTime() ? dueAt : now

    return {
      sends: (missed === 'once' || onTime) ? 1 : 0,
      nextRunAt: nextOccurrence(parser, expression, anchor, tz),
      truncated: false
    }
  }

  /**
   * Anchors schedules that have no pending occurrence: rows upgraded from a schema that stored none,
   * and rows whose claiming process died before it could write the next one back.
   *
   * Nothing is sent. A claim that never reached the send-it queue may equally well have reached it
   * and died after, so replaying it risks a duplicate of a job the operator asked for once.
   */
  private async repairSchedules (stillBroken: Set<string>) {
    const sql = plans.getSchedulesToRepair(this.config.schema, REPAIR_STALE_SECONDS)

    const { rows } = await this.db.executeSql(sql, [this.supportedKinds])

    for (const { name, key, kind, expression, timezone, databaseTime } of rows) {
      const now = databaseTime ? toDate(databaseTime) : this.databaseNow()

      try {
        const parser = this.parsers.get(kind)!
        const nextRunAt = nextOccurrence(parser, expression, now, timezone || 'UTC')

        // null means the recurrence is finished, and the row already records exactly that, so there
        // is nothing to write.
        if (nextRunAt) {
          await this.setNextRun(name, key, nextRunAt)
        }
      } catch (err) {
        await this.warnOnce(stillBroken, [name, key, kind, expression, timezone],
          WARNING_TYPES.INVALID_SCHEDULE,
          `Warning: schedule for queue "${name}" (key "${key}") could not be evaluated and was skipped: ${(err as Error).message}`,
          { queue: name, key, kind, expression, timezone })
      }
    }
  }

  /**
   * Reports due schedules whose kind no parser here understands. They are left untouched for an
   * instance that has the parser, the way a queue with no work() handler is simply never fetched.
   * Without the warning, a kind nobody in the deployment registered is indistinguishable from a
   * schedule that quietly stopped working.
   */
  private async reportUnsupportedKinds (stillBroken: Set<string>) {
    const sql = plans.getUnsupportedDueSchedules(this.config.schema)

    const { rows } = await this.db.executeSql(sql, [this.supportedKinds])

    for (const { name, key, kind, expression } of rows) {
      await this.warnOnce(stillBroken, [name, key, kind],
        WARNING_TYPES.UNSUPPORTED_RECURRENCE,
        `Warning: schedule for queue "${name}" (key "${key}") uses recurrence kind "${kind}", which this instance has no parser for. Register one with the recurrences constructor option.`,
        { queue: name, key, kind, expression })
    }
  }

  /**
   * The occurrence a brand-new schedule waits on.
   *
   * Looks back one grace window rather than starting at the current instant, because that is what
   * cron evaluation did on every pass: scheduling `0 3 * * *` at 03:00:30 has always sent a job
   * immediately, and a schedule created seconds after its own boundary going quiet until tomorrow
   * would be a silent change of behaviour on upgrade.
   *
   * The occurrence that has just passed is only used when it is the most recent one. An expression
   * that recurs faster than the window (a kind with second-level resolution, say) would otherwise
   * start life owing a backlog of occurrences that nobody missed.
   */
  private firstOccurrence (parser: types.RecurrenceParser, expression: string, tz: string): Date | null {
    const now = this.databaseNow()
    const anchor = new Date(now.getTime() - this.missedGraceSeconds * 1000)

    const recent = nextOccurrence(parser, expression, anchor, tz)

    if (recent === null || recent.getTime() > now.getTime()) {
      return recent
    }

    const following = nextOccurrence(parser, expression, recent, tz)

    return (following !== null && following.getTime() <= now.getTime())
      ? nextOccurrence(parser, expression, now, tz)
      : recent
  }

  private async setNextRun (name: string, key: string, nextRunAt: Date | null) {
    if (!nextRunAt) {
      return
    }

    const sql = plans.setScheduleNextRun(this.config.schema)

    await this.db.executeSql(sql, [name, key, nextRunAt])
  }

  /** Emits a schedule warning the first time a run of passes sees it. See warnedSchedules. */
  private async warnOnce (stillBroken: Set<string>, identity: unknown[], type: string, message: string, data: object) {
    const warned = JSON.stringify([type, ...identity])

    stillBroken.add(warned)

    if (!this.warnedSchedules.has(warned)) {
      await emitAndPersistWarning(this.warningContext, type, message, data)
    }
  }

  private async onSendIt (jobs: types.Job<types.Request>[]): Promise<void> {
    const results = await Promise.allSettled(jobs.map(({ data }) => this.manager.send(data)))

    // Surface any failed forward so a lost cron tick isn't silent
    for (const result of results) {
      if (result.status === 'rejected') {
        this.emit(this.events.error, result.reason)
      }
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

  async schedule (name: string, recurrence: string | types.Recurrence, data?: unknown, options: types.ScheduleOptions = {}): Promise<void> {
    const { tz = 'UTC', key = '', missed, ...rest } = options

    const { kind, expression } = toRecurrence(recurrence)

    const parser = this.parsers.get(kind)

    assert(parser, `Unknown recurrence kind "${kind}". Register a parser for it with the recurrences constructor option.`)
    assert(missed === undefined || MISSED_POLICIES.includes(missed),
      `missed must be one of: ${MISSED_POLICIES.join(', ')}`)

    // The parser's own check first, so an expression it cannot evaluate is rejected here rather than
    // stored and then reported, pass after pass, as an unusable row.
    parser.validate?.(expression, tz)

    Attorney.checkSendArgs([name, data, { ...rest }])
    Attorney.assertKey(key)

    // Anchoring the first occurrence at insert time is what lets the cron pass ask the database
    // which schedules are due instead of re-evaluating every expression itself.
    const nextRunAt = this.firstOccurrence(parser, expression, tz)

    try {
      const sql = plans.schedule(this.config.schema)
      await this.db.executeSql(sql, [name, key, kind, expression, tz, data, options, nextRunAt])
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
