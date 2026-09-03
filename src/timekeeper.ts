import { CronExpressionParser } from 'cron-parser'
import EventEmitter from 'node:events'

import * as Attorney from './attorney.ts'
import type Manager from './manager.ts'
import * as plans from './plans.ts'
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

// What the cron pass puts on the send-it queue. `key` identifies the schedule row the occurrence
// came from, so the handler can record the job it produced. It is absent on rows written by an
// instance older than 12.31.0, which is why the handler treats it as optional rather than required.
type ScheduledRequest = types.Request & { key?: string }

// One schedule occurrence that produced a job, as handed to plans.setScheduleLastJobIds. camelCase
// to match the recordset column list the plan quotes, which is how every other JSON payload crossing
// into SQL is shaped.
type FiredSchedule = { name: string, key: string, jobId: string }

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
function assertTimezone (tz: string): void {
  try {
    CronExpressionParser.parse('* * * * *', { tz, strict: false, currentDate: new Date() })
  } catch {
    // Quoted so an empty string renders as `""` rather than a dangling colon
    throw new Error(`Unknown or unsupported time zone: "${tz}"`)
  }
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

  async cron () {
    const schedules = await this.getSchedules()

    const scheduled: types.JobInsert[] = []
    const stillBroken = new Set<string>()

    for (const { name, key, data, options, cron, timezone } of schedules) {
      let due: boolean

      try {
        due = this.shouldSendIt(cron, timezone)
      } catch (err) {
        // Evaluating one row must not decide the fate of the others. schedule() now rejects an
        // unusable time zone, but a row written by an earlier release — or straight into the table —
        // still throws here. This was a single filter() over every schedule, so one such row
        // propagated out of cron() and silently stopped scheduling for every queue in the
        // deployment, on every pass, until someone found the row. Skip it and warn instead, naming
        // the schedule so it is actually fixable.
        const warned = JSON.stringify([name, key, cron, timezone])

        stillBroken.add(warned)

        if (!this.warnedSchedules.has(warned)) {
          await emitAndPersistWarning(
            this.warningContext,
            WARNING_TYPES.INVALID_SCHEDULE,
            `Warning: schedule for queue "${name}" (key "${key}") could not be evaluated and was skipped: ${(err as Error).message}`,
            { queue: name, key, cron, timezone }
          )
        }

        continue
      }

      if (due) {
        // JSON rather than `${name}__${key}`: underscores are legal in both a queue name and a
        // schedule key, so the concatenation collapsed ('report_', 'daily') and ('report', '_daily')
        // onto one key and the 60s singleton then dropped whichever occurrence lost the race. An
        // instance still on the old format writes the old key, so a mixed-version deployment can
        // fire a schedule twice in the minute the rollout straddles.
        scheduled.push({ data: { name, key, data, options }, singletonKey: JSON.stringify([name, key]), singletonSeconds: 60 })
      }
    }

    this.warnedSchedules = stillBroken

    if (scheduled.length > 0 && !this.stopped) {
      await this.manager.insert(QUEUES.SEND_IT, scheduled)
    }
  }

  shouldSendIt (cron: string, tz: string) {
    const databaseTime = Date.now() + this.clockSkew

    const interval = CronExpressionParser.parse(cron, { tz, strict: false, currentDate: new Date(databaseTime) })

    const prevTime = interval.prev()

    const prevDiff = (databaseTime - prevTime.getTime()) / 1000

    return prevDiff < 60
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
      const { key, ...request } = data
      return await this.manager.send(request)
    }))

    // Keyed on (name, key) so a batch that spans two minute buckets for the same schedule resolves
    // to its latest occurrence. Feeding both to the UPDATE would let postgres pick either source
    // row, and last_job_id could end up naming the older job.
    const fired = new Map<string, FiredSchedule>()

    // Surface any failed forward so a lost cron tick isn't silent
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.reportSendItError(result.reason)
        continue
      }

      const { name, key } = jobs[index].data

      // send() resolves null when a throttle or queue policy dropped the job, so there is nothing
      // to point last_job_id at. `key` is absent on a payload written by an older instance.
      if (result.value && key !== undefined) {
        fired.set(JSON.stringify([name, key]), { name, key, jobId: result.value })
      }
    }

    if (fired.size > 0) {
      await this.setLastJobIds([...fired.values()])
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

  async schedule (name: string, cron: string, data?: unknown, options: types.ScheduleOptions = {}): Promise<void> {
    const { tz = 'UTC', key = '', ...rest } = options

    // Expression first, so a bad expression reports as one rather than as a time zone problem. The
    // check is deliberately run against UTC rather than the supplied tz: it only works today
    // because cron-parser is lazy about an unusable zone, and if that ever changes this call would
    // throw the opaque "CronDate: unhandled timestamp" that assertTimezone exists to replace.
    CronExpressionParser.parse(cron, { tz: 'UTC', strict: false })
    assertTimezone(tz)

    Attorney.checkSendArgs([name, data, { ...rest }])
    Attorney.assertKey(key)

    try {
      const sql = plans.schedule(this.config.schema)
      await this.db.executeSql(sql, [name, key, cron, tz, data, options])
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
