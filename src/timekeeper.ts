import assert from 'node:assert'
import { createHash } from 'node:crypto'
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
  MISSED_OCCURRENCES_CAPPED: 'missed_occurrences_capped',
  MISSED_OCCURRENCES_SKIPPED: 'missed_occurrences_skipped'
} as const

const MISSED_POLICIES: types.MissedPolicy[] = ['skip', 'once', 'all']

// Defaults for the three timing policies below, each also a constructor option. How late a
// scheduling pass runs is a property of the deployment rather than of pg-boss: a large schedule
// table, a contended pass slot, and a recurrence kind only some instances can evaluate all delay
// one past what a fixed number here could assume.

// An occurrence claimed within this long of coming due ran on time; anything older was missed while
// no instance was there to claim it, and the schedule's `missed` policy decides its fate. 60 seconds
// is the window cron evaluation used before occurrences were persisted. A monitor interval slow
// enough to overrun it widens the window rather than dropping occurrences the pass simply hadn't got
// to yet.
const MISSED_GRACE_SECONDS = 60

// The most occurrences one pass will send, per schedule and in total. `missed: 'all'` is unbounded
// by construction (a minutely schedule unattended for a week is ten thousand of them), and so is
// the number of schedules that can be owed a catch-up at once. The remainder is dropped and
// reported.
const MAX_CATCHUP_OCCURRENCES = 1000

// How long a schedule may sit with no pending occurrence before repair adopts it. Long enough that a
// row mid-claim (claimed and rescheduled milliseconds apart, in the same pass) is never mistaken for
// an abandoned one.
const REPAIR_STALE_SECONDS = 300

// Namespace for the occurrence ids below. A fixed constant, never regenerated: the whole point is
// that the same occurrence hashes to the same id in every process and every release.
const OCCURRENCE_NAMESPACE = Buffer.from('7c1f0a52e4b04d6d9a3f5c8b21d7e094', 'hex')

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

/**
 * A version 5 (SHA-1, name-based) UUID identifying one occurrence of one schedule.
 *
 * Deterministic, so the same occurrence always produces the same job id and the insert's
 * ON CONFLICT DO NOTHING collapses a repeat. That matters because forwarding is not atomic with the
 * claim: an insert that commits and then loses its acknowledgement is indistinguishable from one
 * that never ran, so the claim is handed back and a later pass forwards the occurrence again. The
 * `singletonSeconds: 60` throttle used to absorb exactly that, at the cost of capping every
 * schedule at one job a minute.
 */
function occurrenceId (name: string, key: string, occurrence: Date): string {
  const bytes = createHash('sha1')
    .update(OCCURRENCE_NAMESPACE)
    .update(`${name}|${key}|${occurrence.toISOString()}`, 'utf8')
    .digest()
    .subarray(0, 16)

  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// insertJobs' recordset accepts singletonOffset and insert() forwards unrecognized keys as-is, but
// it is an internal throttle-bucket knob rather than part of the public JobInsert surface. Declared
// here rather than widening that surface for one caller's benefit.
type ForwardedJob = types.JobInsert & { singletonOffset?: number }

/** What a claimed occurrence turns into: the jobs to send, and when the schedule is next due. */
interface OccurrencePlan {
  /** The occurrences this claim sends a job for, oldest first. */
  occurrences: Date[]
  nextRunAt: Date | null
  /** The run was longer than one pass may send, and the remainder was dropped. */
  truncated: boolean
  /** The default policy wrote the run off for having come due while nothing was claiming. */
  skipped: boolean
}

/** A row returned by the claim, reduced to what occurrence planning reads from it. */
interface ClaimRow {
  kind: string
  expression: string
  timezone: string
  options?: types.ScheduleOptions
}

interface ClaimedOccurrence {
  name: string
  key: string
  dueAt: Date
  plan: OccurrencePlan
}

/** One row of the batched next-occurrence write-back. */
interface ScheduleWrite {
  name: string
  key: string
  nextRunAt: Date | null
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

  /** Grace period for an occurrence claimed late. See the missedGraceSeconds option. */
  private get missedGraceSeconds (): number {
    return this.config.missedGraceSeconds ?? Math.max(MISSED_GRACE_SECONDS, (this.config.cronMonitorIntervalSeconds || 0) * 2)
  }

  /** Ceiling on what one pass may send. See the maxCatchupOccurrences option. */
  private get maxCatchupOccurrences (): number {
    return this.config.maxCatchupOccurrences ?? MAX_CATCHUP_OCCURRENCES
  }

  /** How long a schedule may sit with no pending occurrence. See the scheduleRepairSeconds option. */
  private get repairStaleSeconds (): number {
    return this.config.scheduleRepairSeconds ?? REPAIR_STALE_SECONDS
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
    const failures: unknown[] = []

    // Every phase runs, and the bookkeeping below happens, whichever of them fails. Throwing
    // straight out of the pass would discard `stillBroken`, so the warnings this pass already
    // emitted and persisted would be emitted and persisted again on the next one, every pass, for
    // as long as the failure lasted, which is the unbounded growth warnedSchedules exists to
    // prevent. A phase failing also says nothing about the other two: they are three separate
    // statements against three disjoint sets of rows.
    const phase = async (run: (broken: Set<string>) => Promise<void>) => {
      try {
        await run(stillBroken)
      } catch (err) {
        failures.push(err)
      }
    }

    await phase(broken => this.repairSchedules(broken))
    await phase(broken => this.dispatchSchedules(broken))
    await phase(broken => this.reportUnsupportedKinds(broken))

    this.warnedSchedules = stillBroken

    if (failures.length > 0) {
      throw failures[0]
    }
  }

  /**
   * Claims every occurrence that has come due and forwards it to the send-it queue.
   *
   * Cross-instance exclusion is the row claim itself (see plans.claimDueSchedules), not the
   * `singletonSeconds: 60` throttle the forwarded jobs used to carry: that throttle also capped
   * scheduling at one job per minute per schedule, which a sub-minute kind and `missed: 'all'` both
   * need to exceed. Each job still carries a deterministic id (see occurrenceId), and a cron
   * occurrence on a minute boundary still carries the old minute slot (see throttleSlot), so a
   * repeat of the same occurrence is collapsed rather than sent twice.
   */
  private async dispatchSchedules (stillBroken: Set<string>) {
    const sql = plans.claimDueSchedules(this.config.schema, this.config.noSkipLocked)

    const { rows } = await this.db.executeSql(sql, [this.supportedKinds])

    if (rows.length === 0) {
      return
    }

    const scheduled: ForwardedJob[] = []
    const claims: ClaimedOccurrence[] = []

    // What is left of the pass, not of the schedule. A per-schedule cap alone is one insert
    // statement and one synchronous parser loop that both scale with the number of schedules owed
    // a catch-up, which is how two hundred minutely schedules turn a day of downtime into two
    // hundred thousand parser calls and a single insert of as many rows.
    let budget = this.maxCatchupOccurrences

    for (const row of rows) {
      const { name, key, kind, expression, timezone, data, options } = row

      const now = row.databaseTime ? toDate(row.databaseTime) : this.databaseNow()
      const dueAt = toDate(row.dueAt)

      let plan: OccurrencePlan

      try {
        plan = this.planOccurrences(row, dueAt, now, budget)
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

      budget -= plan.occurrences.length

      for (const occurrence of plan.occurrences) {
        scheduled.push({
          id: occurrenceId(name, key, occurrence),
          data: { name, data, options },
          singletonKey: `${name}__${key}`,
          ...this.throttleSlot(kind, occurrence, now)
        })
      }

      claims.push({ name, key, dueAt, plan })

      if (plan.truncated) {
        await this.warnOnce(stillBroken, [name, key, kind, expression, timezone],
          WARNING_TYPES.MISSED_OCCURRENCES_CAPPED,
          `Warning: schedule for queue "${name}" (key "${key}") was owed more occurrences than one pass may send (${this.maxCatchupOccurrences}); the rest were dropped`,
          { queue: name, key, kind, expression, timezone, cap: this.maxCatchupOccurrences })
      }

      if (plan.skipped) {
        // Without this the drop is invisible: `skip` is the default, so a deployment where nobody
        // claimed in time (an outage, or a kind only some instances can evaluate) writes off
        // occurrence after occurrence and reports nothing at all.
        await this.warnOnce(stillBroken, [name, key, kind, expression, timezone],
          WARNING_TYPES.MISSED_OCCURRENCES_SKIPPED,
          `Warning: schedule for queue "${name}" (key "${key}") came due at ${dueAt.toISOString()}, more than ${this.missedGraceSeconds} seconds before any instance claimed it, and was skipped. Set missed to "once" or "all" to send for occurrences that came due while nothing was claiming.`,
          { queue: name, key, kind, expression, timezone, dueAt: dueAt.toISOString(), graceSeconds: this.missedGraceSeconds })
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

    // A claim whose jobs never reached the queue goes back exactly as it was, for a later pass to
    // re-claim; the policy will then judge for itself whether the occurrence is still worth
    // sending. Everything else advances to the occurrence the parser computed.
    const writes = claims.map(({ name, key, dueAt, plan }) => ({
      name,
      key,
      nextRunAt: (!forwarded && plan.occurrences.length > 0) ? dueAt : plan.nextRunAt
    }))

    await this.setNextRuns(writes).catch((err) => this.emit(this.events.error, err))

    if (forwardError) {
      throw forwardError
    }
  }

  /**
   * Decides which occurrences a claim sends jobs for, and when the schedule is next due.
   *
   * `dueAt` is the occurrence just claimed. The parser may put further occurrences between it and
   * now, which came due in the same gap and belong to the same run: that is how a kind finer than
   * the monitor interval gets every occurrence rather than one per pass. A run the pass reached
   * within the grace window ran on time; an older one came due while no instance was claiming, so
   * the schedule's `missed` policy decides its fate.
   */
  private planOccurrences (row: ClaimRow, dueAt: Date, now: Date, budget: number): OccurrencePlan {
    const parser = this.parsers.get(row.kind)!
    const { expression, timezone } = row
    const tz = timezone || 'UTC'
    const missed = resolveMissedPolicy(row.options?.missed)

    const late = now.getTime() - dueAt.getTime() > this.missedGraceSeconds * 1000

    if (missed === 'once' || (missed === 'skip' && late)) {
      // Anchored past the occurrence as well as past now, so a claim that lands fractionally before
      // the occurrence it just took (the clock estimate is an estimate) cannot re-derive that same
      // occurrence and fire it twice.
      const anchor = dueAt.getTime() > now.getTime() ? dueAt : now

      // Neither answer depends on how long the run turned out to be, so it is never walked: a
      // minutely schedule left alone for a week would cost ten thousand parser calls to arrive at
      // "one" or "none". A parser answers with the first occurrence after the instant it is given,
      // so anchoring on `now` lands on the same occurrence walking there would have.
      return {
        occurrences: missed === 'once' ? [dueAt] : [],
        nextRunAt: nextOccurrence(parser, expression, anchor, tz),
        truncated: false,
        skipped: missed === 'skip'
      }
    }

    // `skip` sends the whole run it arrived in time for and `all` sends the whole run whatever its
    // age, so the two differ only in how long a run can get before the cap bites.
    const cap = Math.max(1, Math.min(this.maxCatchupOccurrences, budget))
    const occurrences = [dueAt]

    let cursor = dueAt
    let truncated = false
    let nextRunAt: Date | null = null

    for (;;) {
      nextRunAt = nextOccurrence(parser, expression, cursor, tz)

      if (nextRunAt === null || nextRunAt.getTime() > now.getTime()) {
        break
      }

      if (occurrences.length >= cap) {
        truncated = true
        nextRunAt = nextOccurrence(parser, expression, now, tz)
        break
      }

      occurrences.push(nextRunAt)
      cursor = nextRunAt
    }

    return { occurrences, nextRunAt, truncated, skipped: false }
  }

  /**
   * The minute slot a forwarded cron job goes in, or nothing for any other kind.
   *
   * A release before schema 40 evaluated every pass itself and forwarded with `singletonSeconds:
   * 60`, which put the job in job_i4's minute slot. Such an instance keeps running happily against
   * a schema-40 database (the contractor only ever migrates forward), so during a rolling upgrade
   * it and an instance claiming rows can both forward the same occurrence, with nothing to collapse
   * the pair. Filing a cron occurrence in that same slot restores it.
   *
   * Only cron, because it is the only kind an instance on old code can evaluate at all, and only on
   * a minute boundary, because that is what makes the slot unambiguous: there is exactly one such
   * occurrence per minute, so the slot can never collapse two distinct occurrences of a schedule,
   * neither a catch-up run nor a 6-field expression that recurs faster than a minute.
   *
   * The offset pins the slot to the occurrence rather than to insert time. Rounded up, so the
   * shifted instant lands on or just after the occurrence: rounding down could put it in the
   * preceding minute, filing the occurrence one slot early.
   */
  private throttleSlot (kind: string, occurrence: Date, now: Date): { singletonSeconds: number, singletonOffset: number } | undefined {
    if (kind !== CRON_KIND || occurrence.getUTCSeconds() !== 0 || occurrence.getUTCMilliseconds() !== 0) {
      return undefined
    }

    return {
      singletonSeconds: 60,
      singletonOffset: Math.ceil((occurrence.getTime() - now.getTime()) / 1000)
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
    const sql = plans.getSchedulesToRepair(this.config.schema, this.repairStaleSeconds)

    const { rows } = await this.db.executeSql(sql, [this.supportedKinds])

    const writes: ScheduleWrite[] = []

    for (const { name, key, kind, expression, timezone, databaseTime } of rows) {
      const now = databaseTime ? toDate(databaseTime) : this.databaseNow()

      try {
        const parser = this.parsers.get(kind)!

        writes.push({ name, key, nextRunAt: nextOccurrence(parser, expression, now, timezone || 'UTC') })
      } catch (err) {
        // Only the parser call is guarded. A database error on the write below says nothing about
        // any particular row, and reporting one as invalid_schedule would name a healthy schedule
        // as broken, then suppress the real error for the life of the process.
        await this.warnOnce(stillBroken, [name, key, kind, expression, timezone],
          WARNING_TYPES.INVALID_SCHEDULE,
          `Warning: schedule for queue "${name}" (key "${key}") could not be evaluated and was skipped: ${(err as Error).message}`,
          { queue: name, key, kind, expression, timezone })
      }
    }

    await this.setNextRuns(writes)
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

    if (rows.length === 0) {
      return
    }

    for (const { name, key, kind, expression } of rows) {
      await this.warnOnce(stillBroken, [name, key, kind],
        WARNING_TYPES.UNSUPPORTED_RECURRENCE,
        `Warning: schedule for queue "${name}" (key "${key}") uses recurrence kind "${kind}", which this instance has no parser for. Register one with the recurrences constructor option.`,
        { queue: name, key, kind, expression })
    }

    // Warning alone leaves the occurrence to rot: the pass slot is deployment-wide, so this
    // instance has just spent the one pass of the interval on rows it cannot evaluate, and an
    // instance that could has no way to be handed the slot. Releasing it lets the next instance to
    // tick try immediately, so a capable one gets there while the occurrence is still on time
    // rather than roughly one interval per instance later, by which point `skip` has written it off.
    await this.db.executeSql(plans.clearCronTime(this.config.schema))
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
   *
   * An occurrence anchored in the past still has to be claimed inside the grace window to be sent,
   * exactly like every later one. A schedule created while nothing was running gets the same
   * treatment its second occurrence would: `skip` resumes at the next one.
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

  /** Advances a whole pass's worth of schedules to the occurrence each is waiting on, in one write. */
  private async setNextRuns (writes: ScheduleWrite[]) {
    // A null occurrence means the recurrence is finished, and the row already records exactly that,
    // so there is nothing to write.
    const pending = writes.filter(({ nextRunAt }) => nextRunAt !== null)

    if (pending.length === 0) {
      return
    }

    const sql = plans.setScheduleNextRun(this.config.schema)

    await this.db.executeSql(sql, [JSON.stringify(pending)])
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
    let nextRunAt: Date | null

    try {
      nextRunAt = this.firstOccurrence(parser, expression, tz)
    } catch (err) {
      // validate() is optional and only has to judge the expression's shape, so an expression that
      // parses and then has no reachable occurrence (February 30, say) fails here instead. Framed
      // rather than rethrown: on its own it is a raw parser message thrown from a code path with
      // nothing to say the caller's expression was the problem.
      throw new Error(`Recurrence expression "${expression}" has no usable first occurrence: ${(err as Error).message}`)
    }

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
