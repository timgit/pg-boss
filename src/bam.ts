import EventEmitter from 'node:events'
import { ClaimTimer } from './claimTimer.ts'
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

class Bam extends EventEmitter implements types.EventsMixin {
  #stopped: boolean
  #working: boolean
  #pollTimer: ClaimTimer | undefined
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

  async stop () {
    if (this.#stopped) return
    this.#stopped = true
    this.#pollTimer!.stop()
    this.#pollTimer = undefined
    while (this.#working) {
      await delay(10)
    }
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

  async #processCommands () {
    if (this.#stopped) return

    const entry = await this.#getNextCommand()
    if (!entry) return

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
      return
    }

    this.emit(events.bam, {
      id: entry.id,
      name: entry.name,
      status: 'in_progress',
      queue: entry.queue,
      table: entry.table
    })

    try {
      let alreadyBuilt = false

      // A re-attempted command (a stale in_progress reclaim, or a retry of a prior 'failed' — including
      // failed rows left by older releases) needs the catalog consulted before the command is re-run,
      // because the row keeps the text it was enqueued with and that text may not be idempotent.
      // Probe indisvalid on every backend: pg_index is readable everywhere, and both outcomes matter.
      if (entry.reattempt) {
        const probeSql = plans.bamHealProbe(this.#config.schema, entry.command)
        if (probeSql) {
          const { rows } = await this.#db.executeSql(probeSql)

          if (rows[0]?.invalid) {
            // An interrupted or failed CREATE INDEX CONCURRENTLY left an INVALID stub. Drop it
            // (best-effort, IF EXISTS) so the re-run rebuilds cleanly instead of the command's own
            // IF NOT EXISTS skipping over a broken index forever. Only on the liveness path —
            // CockroachDB/YugabyteDB roll interrupted builds back, so there is nothing to heal and
            // DROP ... CONCURRENTLY isn't their model.
            if (!this.#config.noIndexProgressView) {
              // Non-null wherever the probe was: both recognise the same CONCURRENTLY commands.
              await this.#db.executeSql(plans.bamHealDrop(this.#config.schema, entry.command)!)
            }
          } else if (rows[0]) {
            // The index is VALID, so the build already succeeded and only the row was never marked (a
            // stop landed between the CREATE and markCompleted). Dropping it would tear down a live
            // production index for the whole rebuild window, and re-running is not safe either: the two
            // oldest index commands (job_i7, job_i8) were queued without IF NOT EXISTS, so re-running
            // one against its own valid index fails with "already exists" and the failed row is retried
            // forever. Short-circuit to marking the row done instead. This half is deliberately NOT
            // gated on the liveness path — the timeout-only backends need it most, because their stale
            // window is BAM_STALE_SECONDS (24 hours) rather than the grace window.
            alreadyBuilt = true
          }
        }
      }

      if (!alreadyBuilt) {
        await this.#db.executeSql(entry.command)
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

      this.emit(events.error, err)

      this.emit(events.bam, {
        id: entry.id,
        name: entry.name,
        status: 'failed',
        queue: entry.queue,
        table: entry.table,
        error: String(err)
      })
    }
  }

  async #getNextCommand (): Promise<BamClaim | null> {
    const sql = plans.getNextBamCommand(this.#config.schema, { useLiveness: !this.#config.noIndexProgressView })
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
