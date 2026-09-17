import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import { ClaimTimer } from '../src/claimTimer.ts'
import { TestClock, systemClock } from '../src/clock.ts'
import type Db from '../src/db.ts'
import type { Clock, ClockTimer } from '../src/types.ts'

/**
 * The interval claims: one instance in a deployment runs a pass per interval, decided by a
 * conditional UPDATE on a timestamp column that only goes through when the row is at least the
 * interval old by the server's clock.
 *
 * The row is stamped when that UPDATE reaches the server, while the attempt that made it was
 * scheduled by a client timer. Run on a fixed grid, the two drift apart by the difference between
 * two statements' latency, and a tick whose statement lands faster than the previous tick's did
 * measures the row a few milliseconds short of the interval and loses the claim for a whole one.
 * ClaimTimer closes that by scheduling the next attempt from the claim rather than from the grid.
 *
 * The first group tests that anchoring in isolation, on a clock that models latency exactly. The
 * second drives the real claims on a TestClock, where every tick lands at exactly the interval and
 * so pins the comparison itself.
 */

/** A hand-driven clock that records when each timer was armed, and by how far out. */
class RecordingClock implements Clock {
  #now: number
  readonly armed: Array<{ at: number, due: number }> = []
  #timers: Array<{ fn: () => void, due: number, handle: ClockTimer }> = []
  #seq = 0

  constructor (start = 0) {
    this.#now = start
  }

  now (): number {
    return this.#now
  }

  /** Moves time forward without firing anything, the way latency inside a callback does. */
  advance (ms: number): void {
    this.#now += ms
  }

  /** Moves time forward and fires whatever comes due, one timer at a time. */
  run (ms: number): void {
    const target = this.#now + ms

    for (;;) {
      const next = this.#timers.filter(t => t.due <= target).sort((a, b) => a.due - b.due)[0]

      if (!next) break

      this.#timers = this.#timers.filter(t => t !== next)
      this.#now = Math.max(this.#now, next.due)
      next.fn()
    }

    this.#now = Math.max(this.#now, target)
  }

  setTimeout (fn: () => void, ms: number): ClockTimer {
    const handle = { id: this.#seq++ } as unknown as ClockTimer

    this.armed.push({ at: this.#now, due: this.#now + ms })
    this.#timers.push({ fn, due: this.#now + ms, handle })

    return handle
  }

  clearTimeout (handle: ClockTimer): void {
    this.#timers = this.#timers.filter(t => t.handle !== handle)
  }

  setInterval (fn: () => void, ms: number): ClockTimer {
    return this.setTimeout(fn, ms)
  }

  clearInterval (handle: ClockTimer): void {
    this.clearTimeout(handle)
  }

  get live (): number {
    return this.#timers.length
  }
}

/** Lets a test await the callbacks a synchronous clock started but did not wait for. */
const settle = async () => { await new Promise(resolve => setImmediate(resolve)) }

describe('claim timer', function () {
  describe('anchoring', function () {
    it('arms the first attempt one interval out', function () {
      const clock = new RecordingClock(1000)
      const timer = new ClaimTimer(clock, 30, async () => {})

      timer.start()

      expect(clock.armed).toEqual([{ at: 1000, due: 31000 }])
    })

    it('measures the next attempt from the claim, not from the tick that started it', async function () {
      const clock = new RecordingClock(0)
      const latencyMs = 40
      const stamps: number[] = []

      // What a pass does: some work, then the claim statement, which takes time to reach the server
      // and stamps the row when it gets there.
      const timer = new ClaimTimer(clock, 30, async () => {
        clock.advance(latencyMs)
        stamps.push(clock.now())
        timer.anchor()
      })

      timer.start()

      for (let i = 0; i < 4; i++) {
        clock.run(30_000)
        await settle()
      }

      // Every gap between two stamps is the interval plus the latency the claim cost, so the claim
      // always measures the row at least the interval old. On a grid the fourth stamp would be at
      // 120_040 and every gap exactly 30_000, which is the value the comparison is against.
      expect(stamps).toEqual([30_040, 60_080, 90_120, 120_160])

      const gaps = stamps.slice(1).map((s, i) => s - stamps[i])

      expect(gaps.every(gap => gap >= 30_000)).toBe(true)
    })

    it('re-arms a pass that returned before it reached its claim', async function () {
      const clock = new RecordingClock(0)
      let attempts = 0

      // The shape of every #onPoll: a guard that returns before the claim when the instance is
      // already working. Nothing anchors, and the chain still has to continue.
      const timer = new ClaimTimer(clock, 10, async () => { attempts++ })

      timer.start()

      for (let i = 0; i < 3; i++) {
        clock.run(10_000)
        await settle()
      }

      expect(attempts).toBe(3)
      expect(clock.live).toBe(1)
    })

    it('re-arms a pass that threw', async function () {
      const clock = new RecordingClock(0)
      let attempts = 0

      // A rejection here is one the pass could not report - an error event with nothing listening -
      // and the timer leaves it to the process, the way setInterval did. So this one is taken off
      // the suite's hands for the window. Only this one: anything else that rejects meanwhile is
      // handed on to the watchers that were there, so a real failure elsewhere still surfaces.
      const watchers = process.listeners('unhandledRejection')
      const mine = (err: unknown) => (err as Error)?.message === 'pass failed'

      process.removeAllListeners('unhandledRejection')
      process.on('unhandledRejection', (err, promise) => {
        if (!mine(err)) for (const watcher of watchers) watcher(err, promise)
      })

      const timer = new ClaimTimer(clock, 10, async () => {
        attempts++
        throw new Error('pass failed')
      })

      try {
        timer.start()

        for (let i = 0; i < 3; i++) {
          clock.run(10_000)
          await settle()
        }
      } finally {
        process.removeAllListeners('unhandledRejection')
        for (const watcher of watchers) process.on('unhandledRejection', watcher)
      }

      // The chain outlived every one of them
      expect(attempts).toBe(3)
      expect(clock.live).toBe(1)
    })

    it('holds one timer at a time, however often a pass anchors', async function () {
      const clock = new RecordingClock(0)
      const timer = new ClaimTimer(clock, 10, async () => {
        timer.anchor()
        timer.anchor()
        timer.anchor()
      })

      timer.start()
      clock.run(10_000)
      await settle()

      expect(clock.live).toBe(1)
    })

    it('stops, and a pass still in flight does not put the chain back', async function () {
      const clock = new RecordingClock(0)
      let attempts = 0

      const timer = new ClaimTimer(clock, 10, async () => {
        attempts++
        timer.stop()
        timer.anchor()
      })

      timer.start()
      clock.run(10_000)
      await settle()

      expect(attempts).toBe(1)
      expect(clock.live).toBe(0)

      clock.run(60_000)
      await settle()

      expect(attempts).toBe(1)
    })

    it('starts once and stops clean', function () {
      const clock = new RecordingClock(0)
      const timer = new ClaimTimer(clock, 10, async () => {})

      timer.start()
      timer.start()
      timer.start()

      expect(clock.live).toBe(1)

      timer.stop()

      expect(clock.live).toBe(0)

      // anchor() after stop is the pass that was in flight when the instance shut down
      timer.anchor()

      expect(clock.live).toBe(0)
    })
  })

  /**
   * On a TestClock a tick lands exactly one period after the last, and job_now() moves with it, so
   * the claim measures the row exactly `seconds` old with none of the jitter a real timer adds.
   * That is the one value the comparison has to accept for a pass to run on every tick.
   */
  describe('on a TestClock', function () {
    const START = '2026-01-01T00:00:00Z'

    async function readClaims (db: Db, queue: string) {
      const { rows: [version] } = await db.executeSql(`SELECT cron_on, bam_on, flow_on FROM ${ctx.schema}.version`)
      const { rows: [q] } = await db.executeSql(`SELECT monitor_claim_on FROM ${ctx.schema}.queue WHERE name = $1`, [queue])
      const at = (d: Date | null) => d ? d.getTime() : null

      return { cron: at(version.cron_on), bam: at(version.bam_on), flow: at(version.flow_on), monitor: at(q?.monitor_claim_on ?? null) }
    }

    it('does not let a scoped supervise() call defer the background pass', async function () {
      // supervise() is public and documented down to `boss.supervise('email-queue')`, so an
      // application may drive one hot queue on its own schedule. Only the timer's own pass
      // re-anchors it: anchoring on a scoped call would push the background pass out by a full
      // interval every time, and every queue the call did not name would stop being monitored.
      const seconds = 30
      const clock = new TestClock(START)

      ctx.boss = await helper.start({
        ...ctx.bossConfig,
        clock,
        schedule: false,
        supervise: true,
        superviseIntervalSeconds: seconds,
        monitorIntervalSeconds: seconds
      })

      const boss = ctx.boss
      const db = boss.getDb() as Db

      await boss.createQueue('a')
      await boss.createQueue('b')

      const claimed = async (queue: string) => (await readClaims(db, queue)).monitor !== null

      // Halfway to the first background pass, the application supervises its own queue
      await clock.tick(seconds * 500)
      await boss.supervise('a')

      expect(await claimed('a'), 'the scoped call claimed the queue it named').toBe(true)
      expect(await claimed('b'), 'and only that one').toBe(false)

      // The rest of the way. The background pass is still due here; it would not be if the scoped
      // call above had re-anchored the timer to its own halfway point.
      await clock.tick(seconds * 500)

      await helper.until(() => claimed('b'), 3000)
        .catch(() => { throw new Error('the background pass never covered the queue the scoped call did not name') })
    })
  })

  describe('against a real clock', function () {
    it('still lets exactly one of several instances take a claim', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false, supervise: false, noDefault: true })

      const db = ctx.boss.getDb() as Db

      await db.executeSql(`UPDATE ${ctx.schema}.version SET cron_on = now() - interval '60 seconds'`)

      const results = await Promise.all([1, 2, 3].map(async () =>
        (await db.executeSql(plans.trySetCronTime(ctx.schema, 30))).rows.length === 1))

      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('keeps the passes an interval apart under a claim that takes its time', async function () {
      const seconds = 1
      const stamps: number[] = []

      ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false, supervise: false, noDefault: true })

      const db = ctx.boss.getDb() as Db

      // A claim whose latency swings from one attempt to the next is what costs a grid-driven timer
      // its claim: a fast attempt after a slow one measures the row short of the interval. Anchored,
      // the swing lands in the gap instead of eating into it.
      let slow = true
      const timer = new ClaimTimer(systemClock, seconds, async () => {
        slow = !slow

        if (slow) await new Promise(resolve => setTimeout(resolve, 120))

        const { rows } = await db.executeSql(plans.trySetCronTime(ctx.schema, seconds))

        timer.anchor()

        if (rows.length === 1) {
          const { rows: [v] } = await db.executeSql(`SELECT cron_on FROM ${ctx.schema}.version`)
          stamps.push(new Date(v.cron_on).getTime())
        }
      })

      timer.start()

      try {
        await helper.until(() => stamps.length >= 6, 20_000)
      } finally {
        timer.stop()
      }

      const gaps = stamps.slice(1).map((s, i) => s - stamps[i])

      // Not one attempt refused: every gap is a full interval, never a fraction of one short
      expect(gaps.length).toBeGreaterThanOrEqual(5)
      expect(gaps.every(gap => gap >= seconds * 1000), `gaps ${gaps.join(', ')}`).toBe(true)
      // And never two intervals, which is what a refused claim costs
      expect(gaps.every(gap => gap < seconds * 2000), `gaps ${gaps.join(', ')}`).toBe(true)
    })
  })
})
