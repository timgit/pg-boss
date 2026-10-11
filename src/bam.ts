import EventEmitter from 'node:events'
import { ClaimTimer } from './claimTimer.ts'
import Db from './db.ts'
import * as plans from './plans.ts'
import { delay } from './tools.ts'
import * as types from './types.ts'

const events = {
  error: 'error',
  bam: 'bam'
}

// What the claim UPDATE overwrote, captured in the same statement. Internal to the runner - the public
// BamEntry describes a stored row, and these two only describe the moment it was claimed.
type BamClaim = types.BamEntry & {
  priorStatus: types.BamEntry['status']
  priorStartedOn: string | null
  // The started_on this claim wrote, used to release only a claim that is still ours.
  claimedStartedOn: string
}

// How a statement still running at the stop() deadline ends, chosen by #execute as it starts:
// - 'abandon': a concurrent index build or drop on Postgres through pg-boss's own pool. The connection
//   is dropped and the server finishes the statement, so no build progress is lost. The row stays
//   in_progress, and the liveness check reads the statement's table lock and holds the row until it
//   ends, so no other instance runs it meanwhile.
// - 'drop': CockroachDB through pg-boss's own pool. The connection is dropped. A schema change
//   finishes as its own job, and any other statement is cancelled with the session. The row is marked
//   failed and runs again.
// - 'cancel': anything else on Postgres, including any statement through a custom database adapter.
//   pg_cancel_backend rolls it back as one transaction. A dropped connection would leave it running
//   unseen until it committed or rolled back. The row is marked failed and runs again. Through
//   pg-boss's own pool the statement's connection is closed once it ends, never returned to the pool,
//   so the cancel cannot land on the statement that would have run on it next.
// - 'wait': a custom database adapter on CockroachDB, with no connection to drop and no
//   pg_cancel_backend, or a cancel that failed. stop() waits for the statement.
type Ending = 'abandon' | 'drop' | 'cancel' | 'wait'

// The claimed row whose statements are in flight, for stop() to end once its deadline passes.
type Running = {
  id: string
  // Set by stop() at its deadline. No statement of the row starts after it.
  stopped: boolean
  // Set once stop() has ended the statement in flight: a cancel reached its backend, or its connection
  // was dropped. A failure after it is the stop's doing, not an error.
  ended: boolean
  ending: Ending
  abort: AbortController
}

// How often stop() repeats a cancel that found nothing to cancel. It can land between two statements
// of one row, or before the statement reaches the server. It also finds nothing when the role cannot
// see the statement in pg_stat_activity, and then stop() keeps trying until the statement ends.
const CANCEL_RETRY_MS = 1000

class Bam extends EventEmitter implements types.EventsMixin {
  #stopped: boolean
  #working: boolean
  #pollTimer: ClaimTimer | undefined
  #running: Running | undefined
  #db: types.IDatabase
  #config: types.ResolvedConstructorOptions

  events = events

  constructor (
    db: types.IDatabase,
    config: types.ResolvedConstructorOptions
  ) {
    super()

    this.#db = db
    this.#config = config
    this.#stopped = true
    this.#working = false
  }

  get working (): boolean {
    return this.#working
  }

  async start () {
    if (!this.#stopped) return
    this.#stopped = false

    this.#pollTimer = new ClaimTimer(
      this.#config.clock,
      this.#config.bamIntervalSeconds,
      () => this.#onPoll()
    )

    setImmediate(() => this.#onPoll())
    this.#pollTimer.start()
  }

  // Waits for a running command until deadline resolves, then ends it (see Ending) and waits for
  // that to land, so the row is recorded before index.ts closes the pool. Without a deadline it waits
  // for the command to finish.
  async stop (deadline?: Promise<void>) {
    if (this.#stopped) return
    this.#stopped = true
    this.#pollTimer!.stop()
    this.#pollTimer = undefined

    let expired = false
    deadline?.then(() => { expired = true })

    let endedAt = 0

    while (this.#working) {
      const running = this.#running

      if (expired && running) {
        running.stopped = true

        if (!running.ended && running.ending !== 'wait' && Date.now() - endedAt >= CANCEL_RETRY_MS) {
          endedAt = Date.now()
          await this.#end(running)
        }
      }

      await delay(10)
    }
  }

  async #end (running: Running) {
    if (running.ending === 'abandon' || running.ending === 'drop') {
      running.abort.abort()
      running.ended = true
      return
    }

    // Before the cancel reads pg_stat_activity, so a statement that ends after the read closes its
    // connection rather than returning it to the pool with the cancel still on its way.
    running.abort.abort()

    try {
      const { rows } = await this.#db.executeSql(plans.cancelBamCommand(running.id))
      running.ended = rows.some(row => row.cancelled)
    } catch (err) {
      // Usually a role that can see the statement but not signal its backend, which a retry will not
      // change. Report it once and wait for the statement.
      running.ending = 'wait'
      this.emit(events.error, err)
    }
  }

  // Runs one of a claimed row's statements so stop() can end it. See Ending.
  async #execute (running: Running, sql: string) {
    if (running.stopped) {
      // Nothing is left running for the row to wait on, whatever the previous statement was.
      running.ending = 'wait'
      running.ended = true
      throw new Error('stop() ended the command before it ran')
    }

    const cockroach = this.#config.backend === 'cockroachdb'

    if (!(this.#db instanceof Db)) {
      running.ending = cockroach ? 'wait' : 'cancel'
    } else if (cockroach) {
      running.ending = 'drop'
    } else {
      running.ending = !this.#config.noIndexProgressView && plans.isConcurrentIndexCommand(sql) ? 'abandon' : 'cancel'
    }

    // CockroachDB drops comments from the statement text it reports, so the tag only serves Postgres.
    const text = cockroach ? sql : `${plans.bamCommandTag(running.id)}\n${sql}`

    if (!(this.#db instanceof Db)) {
      return await this.#db.executeSql(text)
    }

    return await this.#db.executeSql(text, undefined, running.ending === 'cancel'
      ? { retire: running.abort.signal }
      : { signal: running.abort.signal })
  }

  async #onPoll () {
    if (this.#stopped || this.#working || !this.#config.migrate) return

    this.#working = true

    try {
      if (this.#config.__test__throw_bam) {
        throw new Error(this.#config.__test__throw_bam)
      }

      if (this.#config.__test__delay_bam_ms) {
        await delay(this.#config.__test__delay_bam_ms)
      }

      const sql = plans.trySetBamTime(
        this.#config.schema,
        this.#config.bamIntervalSeconds
      )
      const { rows } = await this.#db.executeSql(sql)

      // The row is stamped; the next attempt is measured from here rather than from the tick that
      // started this one. See ClaimTimer.
      this.#pollTimer?.anchor()

      if (rows.length === 1) {
        await this.#processCommands()
      }
    } catch (err) {
      this.emit(events.error, err)
    } finally {
      this.#working = false
    }
  }

  // Runs commands back to back once a poll finds one, rather than one per bamIntervalSeconds, so a
  // migration's builds land one after another. The first claim may retry a failed or stale row; the
  // rest take pending rows only, and the burst ends when none is left or the runner stops.
  async #processCommands () {
    let pendingOnly = false

    while (!this.#stopped && await this.#processNextCommand(pendingOnly)) {
      pendingOnly = true
    }
  }

  // Claims and runs one command. Returns whether a command was claimed, whatever its outcome.
  async #processNextCommand (pendingOnly: boolean): Promise<boolean> {
    const entry = await this.#getNextCommand(pendingOnly)
    if (!entry) return false

    if (this.#config.__test__delay_bam_claim_ms) {
      await delay(this.#config.__test__delay_bam_claim_ms)
    }

    if (this.#stopped) {
      // The claim landed on the wrong side of a stop. The command has not run, so hand the row back
      // exactly as it was found rather than leaving it in_progress - an in_progress row blocks the
      // whole BAM queue until it goes stale, which is the grace window on native Postgres and 24
      // hours on the timeout-only backends. If the release itself fails the row keeps that claim and
      // recovers on the stale path, so surface it rather than throwing into #onPoll.
      try {
        await this.#releaseCommand(entry)
      } catch (err) {
        this.emit(events.error, err)
      }
      return false
    }

    const running: Running = { id: entry.id, stopped: false, ended: false, ending: 'wait', abort: new AbortController() }
    this.#running = running

    this.emit(events.bam, {
      id: entry.id,
      name: entry.name,
      status: 'in_progress',
      queue: entry.queue,
      table: entry.table
    })

    try {
      let alreadyBuilt = false

      // Non-null for a CONCURRENTLY index build, which is checked against the catalog before a
      // re-attempt and after the build returns.
      const probeSql = plans.bamHealProbe(this.#config.schema, entry.command)

      // A re-attempted command (a stale in_progress reclaim, or a retry of a prior 'failed', including
      // failed rows left by older releases) needs the catalog consulted before the command is re-run,
      // because the row keeps the text it was enqueued with and that text may not be idempotent.
      // Probe indisvalid on every backend: pg_index is readable everywhere, and both outcomes matter.
      if (entry.reattempt) {
        if (probeSql) {
          const { rows } = await this.#db.executeSql(probeSql)

          if (rows[0]?.invalid) {
            // An interrupted or failed CREATE INDEX CONCURRENTLY left an INVALID stub. Drop it
            // (best-effort, IF EXISTS) so the re-run rebuilds cleanly instead of the command's own
            // IF NOT EXISTS skipping over a broken index forever. Only on the liveness path,
            // CockroachDB/YugabyteDB roll interrupted builds back, so there is nothing to heal and
            // DROP ... CONCURRENTLY isn't their model.
            if (!this.#config.noIndexProgressView) {
              // Non-null wherever the probe was: both recognise the same CONCURRENTLY commands.
              await this.#execute(running, plans.bamHealDrop(this.#config.schema, entry.command)!)
            }
          } else if (rows[0]) {
            // The index is VALID, so the build already succeeded and only the row was never marked (a
            // stop landed between the CREATE and markCompleted). Dropping it would tear down a live
            // production index for the whole rebuild window, and re-running is not safe either: the two
            // oldest index commands (job_i7, job_i8) were queued without IF NOT EXISTS, so re-running
            // one against its own valid index fails with "already exists" and the failed row is retried
            // forever. Short-circuit to marking the row done instead. This half is deliberately NOT
            // gated on the liveness path. The timeout-only backends need it most, because their stale
            // window is BAM_STALE_SECONDS (24 hours) rather than the grace window.
            alreadyBuilt = true
          }
        }
      }

      if (!alreadyBuilt) {
        await this.#execute(running, entry.command)

        // A build can return without leaving a valid index. On CockroachDB, a retry of a build whose
        // connection stop() dropped returns at once while the first build still runs as a schema
        // change job, because IF NOT EXISTS matches the index it is adding, which pg_index does not
        // list yet. On Postgres, IF NOT EXISTS skips over an INVALID index of the same name. Marking
        // the row completed then would release the commands behind it, and nothing would build the
        // index again if that job failed. Failing the row has a later attempt check again, where the
        // probe completes it or heals the INVALID index. Without liveness there is no heal, so an
        // INVALID index would fail every retry, and the row completes as before.
        if (probeSql) {
          const { rows } = await this.#db.executeSql(probeSql)

          if (!rows[0] || (rows[0].invalid && !this.#config.noIndexProgressView)) {
            const name = plans.bamCommandIndexName(entry.command)
            throw new Error(rows[0]
              ? `index ${name} is invalid after the build`
              : `index ${name} does not exist after the build. An earlier build of it may still be running.`)
          }
        }
      }

      // Record the outcome even when a stop landed while the command was running. stop() waits out
      // #working and index.ts closes the pool only after #bam.stop() resolves, so the UPDATE is safe
      // here. Bailing out instead would strand a VALID index behind an unmarked row: on native
      // Postgres the whole BAM queue then waits out BAM_LIVENESS_GRACE_SECONDS, and on the
      // timeout-only backends (CockroachDB/YugabyteDB) every other command is blocked for
      // BAM_STALE_SECONDS - 24 hours - before anything is retried. A failure here falls through to
      // the catch, which marks the row failed - the next attempt's probe finds the VALID index and
      // completes it.
      await this.#markCompleted(entry.id)

      this.emit(events.bam, {
        id: entry.id,
        name: entry.name,
        status: 'completed',
        queue: entry.queue,
        table: entry.table
      })
    } catch (err) {
      // The one failure that leaves the row in_progress: stop() dropped the connection under a
      // concurrent index statement that the server is still running. See Ending.
      if (running.ended && running.ending === 'abandon') {
        return true
      }

      // Same reasoning as the completed path: a stop must not leave the row in_progress. This write
      // is guarded because it commonly runs on the connection that just failed - a terminated backend
      // or dropped connection fails the command AND the UPDATE that would record it. Letting that
      // throw would replace the real failure with the write's error and lose which command failed,
      // so report both and let the stale path reclaim the row.
      try {
        await this.#markFailed(entry.id, err)
      } catch (markErr) {
        this.emit(events.error, markErr)
      }

      // A failure stop() caused is not an error. The row still records it, so the next attempt runs
      // as a reattempt and heals what the cancel left.
      if (!running.ended) {
        this.emit(events.error, err)
      }

      this.emit(events.bam, {
        id: entry.id,
        name: entry.name,
        status: 'failed',
        queue: entry.queue,
        table: entry.table,
        error: String(err)
      })
    } finally {
      this.#running = undefined
    }

    return true
  }

  async #getNextCommand (pendingOnly: boolean): Promise<BamClaim | null> {
    const sql = plans.getNextBamCommand(this.#config.schema, { useLiveness: !this.#config.noIndexProgressView, pendingOnly })
    const { rows } = await this.#db.executeSql(sql)
    return rows[0] || null
  }

  async #releaseCommand (entry: BamClaim): Promise<void> {
    const sql = plans.releaseBamCommand(
      this.#config.schema,
      entry.id,
      entry.priorStatus,
      entry.priorStartedOn ?? null,
      entry.claimedStartedOn
    )
    await this.#db.executeSql(sql)
  }

  async #markCompleted (id: string): Promise<void> {
    const sql = plans.setBamCompleted(this.#config.schema, id)
    await this.#db.executeSql(sql)
  }

  async #markFailed (id: string, error: unknown): Promise<void> {
    const sql = plans.setBamFailed(this.#config.schema, id, String(error))
    await this.#db.executeSql(sql)
  }
}

export default Bam
