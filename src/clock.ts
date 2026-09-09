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

interface Timer {
  fn: () => void
  due: number
  seq: number
  interval: number | null
}

interface Target {
  db: IDatabase
  schema: string
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
 * through ${schema}.now(), so JavaScript and Postgres agree on what "now" is.
 */
export class TestClock implements AttachableClock {
  #now: number
  #timers: Timer[] = []
  #seq = 0
  #ticking = false
  // Every (db, schema) this clock currently pushes time to. More than one because a multi-instance
  // test shares one clock across several PgBoss instances, each of which attaches on start(); the
  // schema's now() is restored only when the last of them disposes its handle.
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

  /** Jumps to a time, forwards or backwards, firing nothing. */
  async setTime (t: Date | number | string): Promise<void> {
    this.#now = toMillis(t)
    await this.#push()
  }

  /**
   * Advances by ms, firing each due timer in order at its own due time. Does not wait for I/O the
   * callbacks start; observe effects with spies or by querying.
   */
  async tick (ms: number): Promise<void> {
    if (this.#ticking) {
      throw new Error('TestClock: tick() called while a tick is in progress')
    }

    this.#ticking = true

    try {
      const target = this.#now + ms

      while (this.#timers.length && this.#timers[0].due <= target) {
        const timer = this.#timers.shift()!

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

        await setImmediate()
      }

      this.#now = target
      await this.#push()
      await setImmediate()
    } finally {
      this.#ticking = false
    }
  }

  async attach (target: Target): Promise<AsyncDisposable> {
    const { db, schema } = target

    await db.executeSql(`
      CREATE TABLE IF NOT EXISTS ${schema}.clock (now timestamp with time zone NOT NULL);
      DELETE FROM ${schema}.clock;
      ${plans.createClockFunction(schema, { replace: true, body: plans.clockOverrideBody(schema) })}
    `)
    await db.executeSql(`INSERT INTO ${schema}.clock (now) VALUES (to_timestamp($1))`, [this.#now / 1000])

    const entry: Target = { db, schema }
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
            DROP TABLE IF EXISTS ${schema}.clock;
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
      db.executeSql(`UPDATE ${schema}.clock SET now = to_timestamp($1)`, [seconds])
    ))
  }
}
