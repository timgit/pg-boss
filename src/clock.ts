import { setImmediate } from 'node:timers/promises'
import * as plans from './plans.ts'
import type { AttachableClock, Clock, ClockTimer, IDatabase } from './types.ts'

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle: ClockTimer) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle: ClockTimer) => clearInterval(handle as NodeJS.Timeout)
}

export function isAttachable (clock: Clock): clock is AttachableClock {
  return typeof (clock as Partial<AttachableClock>).attach === 'function'
}

interface Timer {
  fn: () => void
  due: number
  seq: number
  interval: number | null
}

interface Target {
  db: IDatabase
  schema: string
  idle?: () => Promise<boolean>
}

function toMillis (t: Date | number | string): number {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime()
  if (!Number.isFinite(ms)) {
    throw new Error(`TestClock: invalid time ${String(t)}`)
  }
  return ms
}

/**
 * A clock a test drives by hand. Time only moves through setTime() and tick(); timers only fire
 * from tick(). When attached to a schema, every pg-boss statement there reads the same time
 * through ${schema}.job_now(), so JavaScript and Postgres agree on what "now" is.
 */
export class TestClock implements AttachableClock {
  #now: number
  #timers: Timer[] = []
  #seq = 0
  #ticking = false
  // Every (db, schema) this clock currently pushes time to. More than one because a multi-instance
  // test shares one clock across several PgBoss instances, each of which attaches on start(). The
  // schema is shared, so the last handle to be disposed is the one that restores job_now() and
  // drops the clock table; the session opt-in is separate, and each instance drops its own.
  #targets: Target[] = []

  constructor (start: Date | number | string = Date.now()) {
    this.#now = toMillis(start)
  }

  now (): number {
    return this.#now
  }

  setTimeout (fn: () => void, ms: number): ClockTimer {
    return this.#schedule(fn, ms, null)
  }

  setInterval (fn: () => void, ms: number): ClockTimer {
    return this.#schedule(fn, ms, Math.max(ms, 1))
  }

  clearTimeout (handle: ClockTimer): void {
    const i = this.#timers.indexOf(handle as Timer)
    if (i !== -1) this.#timers.splice(i, 1)
  }

  clearInterval (handle: ClockTimer): void {
    this.clearTimeout(handle)
  }

  /**
   * Jumps to a time, forwards or backwards, firing nothing. Settles first, so work already in
   * flight finishes on the time it started under. Postgres sees a forward jump as elapsed time, so
   * JS timers do too: each one the jump passed fires once on the next tick, as if the process had
   * slept, and an interval then keeps its period from there instead of replaying every period it
   * skipped. A backward jump leaves timers alone, so JS deadlines still agree with the database's.
   */
  async setTime (t: Date | number | string): Promise<void> {
    if (this.#ticking) {
      throw new Error('TestClock: setTime() called while a tick is in progress')
    }

    const next = toMillis(t)

    await this.#settle()

    // #timers is sorted by due time, so the overdue timers are a prefix and stay sorted once moved.
    for (const timer of this.#timers) {
      if (timer.due >= next) break
      timer.due = next
    }

    this.#now = next
    await this.#push()
  }

  /**
   * Advances by ms, firing each due timer in order at its own due time. After each timer, and
   * before and after the whole advance, waits until pg-boss has no statement in flight, so a poll
   * the tick fired finishes, and anything it re-arms before the target fires in this same tick.
   * Does not wait for job handlers; observe their effects with spies or by querying.
   */
  async tick (ms: number): Promise<void> {
    if (this.#ticking) {
      throw new Error('TestClock: tick() called while a tick is in progress')
    }

    this.#ticking = true

    try {
      await this.#settle()

      const target = this.#now + ms

      for (;;) {
        const timer = this.#timers[0]

        if (timer && timer.due <= target) {
          this.#timers.shift()

          if (timer.due > this.#now) {
            this.#now = timer.due
            await this.#push()
          }

          // Reinsert the same object so the handle handed out by setInterval still clears it.
          if (timer.interval !== null) {
            timer.due += timer.interval
            timer.seq = this.#seq++
            this.#insert(timer)
          }

          timer.fn()
        } else if (this.#now < target) {
          this.#now = target
          await this.#push()
        } else {
          break
        }

        await this.#settle()
      }
    } finally {
      this.#ticking = false
    }
  }

  async attach (target: Target): Promise<AsyncDisposable> {
    const { db, schema } = target

    // One batch, so the override function is never visible over an empty table: the body reads the
    // single row and COALESCEs to pg_catalog.now() when it finds none, so a seed in a second round
    // trip would serve real time to anything calling job_now() in between. The timestamp is a
    // literal because a parameterised statement cannot carry more than one command; it is derived
    // from this.#now, a number, so there is nothing here to inject.
    //
    // Dropped and recreated rather than IF NOT EXISTS: adopting a table that is already there would
    // mean wiping rows this clock did not write, and dropping it on release. The name is one nobody
    // else would pick, so a table under it is always a leftover from a killed run and safe to take.
    await db.executeSql(`
      DROP TABLE IF EXISTS ${plans.clockTable(schema)};
      CREATE TABLE ${plans.clockTable(schema)} (now timestamp with time zone NOT NULL);
      ${plans.createClockFunction(schema, { replace: true, body: plans.clockOverrideBody(schema) })}
      INSERT INTO ${plans.clockTable(schema)} (now) VALUES (to_timestamp(${this.#now / 1000}));
    `)
    // The session opt-in is not issued here. attach() runs after the contractor has already opened
    // connections and migrated, so a SET on this one session would miss every other one. PgBoss
    // declares it through db.setSessionStatements() before anything opens; see #doStart.

    const entry: Target = { db, schema, idle: target.idle }
    this.#targets.push(entry)

    let disposed = false

    return {
      [Symbol.asyncDispose]: async () => {
        if (disposed) return
        disposed = true

        this.#targets.splice(this.#targets.indexOf(entry), 1)

        if (!this.#targets.some(t => t.schema === schema)) {
          await db.executeSql(`
            ${plans.createClockFunction(schema, { replace: true })}
            DROP TABLE IF EXISTS ${plans.clockTable(schema)};
            ${plans.disableClockOverride()};
          `)
        }
      }
    }
  }

  #schedule (fn: () => void, ms: number, interval: number | null): ClockTimer {
    const timer: Timer = { fn, due: this.#now + Math.max(ms, 0), seq: this.#seq++, interval }
    this.#insert(timer)
    return timer
  }

  // Keeps #timers sorted by due time, then by scheduling order for equal due times, so tick() can
  // always take the next timer from the front.
  #insert (timer: Timer) {
    let i = this.#timers.length

    while (i > 0) {
      const previous = this.#timers[i - 1]
      const laterDue = previous.due > timer.due
      const sameDueScheduledLater = previous.due === timer.due && previous.seq > timer.seq

      if (!laterDue && !sameDueScheduledLater) break

      i--
    }

    this.#timers.splice(i, 0, timer)
  }

  async #push (): Promise<void> {
    const seconds = this.#now / 1000

    await Promise.all(this.#targets.map(({ db, schema }) =>
      db.executeSql(`UPDATE ${plans.clockTable(schema)} SET now = to_timestamp($1)`, [seconds])
    ))
  }

  // Repeats until every target is quiet in the same pass: one instance going quiet can wake
  // another, for example through a NOTIFY, after that one's idle() has already returned.
  async #settle (): Promise<void> {
    for (;;) {
      await setImmediate()
      const waited = await Promise.all(this.#targets.map(t => t.idle ? t.idle() : false))
      if (!waited.includes(true)) return
    }
  }
}
