import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import { ClaimTimer } from '../src/claimTimer.ts'
import Timekeeper from '../src/timekeeper.ts'
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

    it('arms the next attempt at the wait a caller names, not at the interval', async function () {
      const clock = new RecordingClock(0)

      // What a refused cron claim does: it knows when the row it lost to comes due, so it says how
      // long to wait rather than taking the interval it would otherwise measure from its own
      // failure. The last attempt names nothing, which is the winner's path.
      const waits: Array<number | undefined> = [7_000, 0]
      const timer = new ClaimTimer(clock, 30, async () => { timer.anchor(waits.shift()) })

      timer.start()

      clock.run(30_000)
      await settle()

      clock.run(7_000)
      await settle()

      clock.run(0)
      await settle()

      expect(clock.armed.map(({ at, due }) => due - at)).toEqual([30_000, 7_000, 0, 30_000])
    })

    /**
     * A Timekeeper over a claim that answers however the caller says, on a clock that records what
     * its pass arms next. Nothing else about the instance is real: a pass that did not take the
     * claim returns at it, and one that did finds no schedules.
     */
    function claimAnswering (seconds: number, elapsed: unknown, claimed: unknown = false) {
      const clock = new RecordingClock(0)
      const db = { executeSql: async () => ({ rows: [{ claimed, elapsed, priorCronOn: null }] }) }
      const config = { schema: 'test', clock, cronMonitorIntervalSeconds: seconds }
      const tk = new Timekeeper(db as any, {} as any, config as any) as any

      tk.stopped = false
      tk.cronMonitorTimer = new ClaimTimer(clock, seconds, async () => {})
      tk.cronMonitorTimer.start()

      return { tk, clock }
    }

    /** What the pass armed, which is every attempt after the one start() put on the clock. */
    const armedAfter = async (seconds: number, elapsed: unknown, claimed: unknown = false) => {
      const { tk, clock } = claimAnswering(seconds, elapsed, claimed)

      tk.getSchedules = async () => []

      await tk.onCron()

      const [, next] = clock.armed

      return next.due - next.at
    }

    it('comes back when the row it lost the claim to is due, plus a beat', async function () {
      // The beat is a quarter of the interval capped at a second, so it stays a beat at the smallest
      // configurable interval instead of doubling it. Without it the retry lands on the due instant
      // itself, where the holder's own attempt lands and where the row can still be a microsecond
      // short.
      expect(await armedAfter(30, 10), 'a third of the way into the interval').toBe(21_000)
      expect(await armedAfter(30, 29.5), 'most of the way through it').toBe(1_500)
      expect(await armedAfter(2, 1), 'an interval whose quarter is under a second').toBe(1_500)

      // node-postgres hands EXTRACT() back as a numeric, which is a string
      expect(await armedAfter(30, '10.25'), 'the age as a driver renders it').toBe(20_750)

      // Refused against a row already past the interval: a winner committed between this statement's
      // snapshot and its UPDATE, so the wait is the beat alone and the next attempt measures again.
      expect(await armedAfter(30, 45), 'a row the snapshot saw as already due').toBe(1_000)

      // A row no pass has stamped reads as no age at all. No claim is refused in that state, so the
      // answer only has to be sane: one interval, which is what the timer would have taken anyway.
      expect(await armedAfter(30, null), 'no timestamp on the row').toBe(31_000)
      expect(await armedAfter(30, undefined), 'no column at all').toBe(31_000)
    })

    it('reads a taken claim in every shape a driver hands one back', async function () {
      // A boolean from every driver that parses one, its text or an integer from an adapter over a
      // backend that speaks JSON. A winner anchors to its own stamp, so it arms one interval out
      // where a refused instance would have armed the 21 seconds left on the row plus a beat.
      for (const claimed of [true, 'true', 'TRUE', 't', 1, '1']) {
        expect(await armedAfter(30, 10, claimed), `claimed as ${JSON.stringify(claimed)}`).toBe(30_000)
      }

      for (const refused of [false, 'false', 'f', 0, '0', null, undefined]) {
        expect(await armedAfter(30, 10, refused), `refused as ${JSON.stringify(refused)}`).toBe(21_000)
      }
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

    it('does not attempt before the interval is up on a timer that fires early', async function () {
      // Node's timers run on the monotonic clock and now and then fire a millisecond short of the
      // wall clock. Against PGlite, whose now() is to the millisecond, that refused the claim. A
      // wait of a millisecond still waits one, the way a real timer does.
      class EarlyClock extends RecordingClock {
        setTimeout (fn: () => void, ms: number): ClockTimer {
          return super.setTimeout(fn, ms > 1 ? ms - 1 : ms)
        }
      }

      const clock = new EarlyClock(0)
      const stamps: number[] = []

      const timer = new ClaimTimer(clock, 1, async () => {
        stamps.push(clock.now())
        timer.anchor()
      })

      timer.start()

      for (let i = 0; i < 3; i++) {
        clock.run(1000)
        await settle()
      }

      expect(stamps).toEqual([1000, 2000, 3000])
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

    it('takes a claim at exactly the interval and refuses one a millisecond short', async function () {
      const clock = new TestClock(START)

      ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: false, supervise: false, noDefault: true })

      const db = ctx.boss.getDb() as Db
      const seconds = 30

      // bam claims bam_on the moment the instance starts; let that land before writing the column
      await helper.until(async () => (await readClaims(db, '')).bam !== null)

      const claim = async () => (await db.executeSql(plans.trySetCronTime(ctx.schema, seconds))).rows[0].claimed === true
      const write = async (ago: number) => {
        await db.executeSql(`UPDATE ${ctx.schema}.version SET cron_on = ${ctx.schema}.job_now() - interval '${ago} seconds'`)
      }

      await write(seconds)

      expect(await claim(), 'exactly the interval').toBe(true)

      await write(seconds - 0.001)

      expect(await claim(), 'a millisecond short of the interval').toBe(false)

      await write(seconds + 0.001)

      expect(await claim(), 'a millisecond past the interval').toBe(true)
    })

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

    it('runs every claim on every tick, tick after tick', async function () {
      // One period for all of them, so each tick is exactly one interval for every claim at once
      const seconds = 30
      const clock = new TestClock(START)

      ctx.boss = await helper.start({
        ...ctx.bossConfig,
        clock,
        schedule: true,
        supervise: true,
        cronMonitorIntervalSeconds: seconds,
        bamIntervalSeconds: seconds,
        flowIntervalSeconds: seconds,
        superviseIntervalSeconds: seconds,
        monitorIntervalSeconds: seconds
      })

      const boss = ctx.boss
      const db = boss.getDb() as Db

      await boss.createQueue('q')

      const t0 = new Date(START).getTime()

      // cron, bam and flow each try once as they start; supervise first runs on its first tick
      await helper.until(async () => {
        const c = await readClaims(db, 'q')
        return c.cron === t0 && c.bam === t0 && c.flow === t0
      })

      for (let i = 1; i <= 4; i++) {
        // A tick that lands while the previous pass is still running is dropped, by design, and a
        // chained timer only re-arms once its pass is done - so let the instance go quiet first.
        await helper.until(() => !boss.isMaintaining())
        await new Promise(resolve => setTimeout(resolve, 100))

        await clock.tick(seconds * 1000)

        const expected = t0 + i * seconds * 1000

        await helper.until(async () => {
          const c = await readClaims(db, 'q')
          return c.cron === expected && c.bam === expected && c.flow === expected && c.monitor === expected
        }, 3000).catch(async () => {
          const c = await readClaims(db, 'q')
          const off = (v: number | null) => v === null ? 'null' : `+${(v - t0) / 1000}s`
          throw new Error(`after tick ${i} (clock at +${i * seconds}s): cron ${off(c.cron)}, bam ${off(c.bam)}, flow ${off(c.flow)}, monitor ${off(c.monitor)}`)
        })
      }
    })
  })

  /**
   * A rolling upgrade puts instances on both releases against the same version and queue rows. The
   * whole of the difference between them is the comparison: the release before this one wrote `>`
   * where this one writes `>=`, so the only elapsed time the two disagree on is exactly the
   * interval. These pin that, in both directions, for all three statements the change touched.
   *
   * Driven on a TestClock because "exactly the interval" is the case at issue, and a real clock
   * measures elapsed time to the microsecond - the one value that cannot be hit on purpose.
   */
  describe('alongside an instance on the previous release', function () {
    const START = '2026-01-01T00:00:00Z'

    /** The previous release's claims: these statements with the comparison strict. */
    const previous = {
      version: (column: string) => (schema: string, seconds: number) => `
        UPDATE ${schema}.version
        SET ${column} = ${schema}.job_now()
        WHERE EXTRACT( EPOCH FROM (${schema}.job_now() - COALESCE(${column}, ${schema}.job_now() - interval '1 week') ) ) > ${seconds}
        RETURNING true
      `,
      cron: (schema: string, seconds: number) => `
        WITH prior AS (
          SELECT cron_on FROM ${schema}.version
        ), claim AS (
          ${previous.version('cron_on')(schema, seconds)}
        )
        SELECT prior.cron_on as "priorCronOn" FROM prior, claim
      `,
      queue: (column: string) => (schema: string, queues: string[], seconds: number) => ({
        text: `
        UPDATE ${schema}.queue
        SET ${column} = ${schema}.job_now()
        WHERE name = ANY($1::text[])
          AND EXTRACT( EPOCH FROM (${schema}.job_now() - COALESCE(${column}, ${schema}.job_now() - interval '1 week') ) ) > ${seconds}
        RETURNING name
      `,
        values: [queues]
      }),
      monitor: (schema: string, queues: string[], seconds: number) => ({
        text: `
        UPDATE ${schema}.queue
        SET monitor_claim_on = ${schema}.job_now()
        WHERE name = ANY($1::text[])
          AND EXTRACT( EPOCH FROM (${schema}.job_now() - COALESCE(monitor_claim_on, monitor_on, ${schema}.job_now() - interval '1 week') ) ) > ${seconds}
        RETURNING name, NOT EXISTS (SELECT 1 FROM ${schema}.version WHERE monitor_backoff_on > ${schema}.job_now()) as "refreshStats"
      `,
        values: [queues]
      })
    }

    const SECONDS = 30

    /**
     * A migrated schema with an idle instance holding the clock, so the test drives every claim
     * itself. The instance has to stay up: stopping it releases the TestClock, and job_now() falls
     * back to real time, where "exactly the interval" cannot be written. Nothing of its own runs -
     * no schedule, no supervise, and the one claim bam takes as it starts is on a column no test
     * here touches.
     */
    async function quiet (queues: string[] = []) {
      const clock = new TestClock(START)

      ctx.boss = await helper.start({ ...ctx.bossConfig, clock, schedule: false, supervise: false, noDefault: true })

      for (const queue of queues) {
        await ctx.boss.createQueue(queue)
      }

      const db = ctx.boss.getDb() as Db

      await helper.until(async () => (await db.executeSql(`SELECT bam_on FROM ${ctx.schema}.version`)).rows[0].bam_on !== null)

      return { db, clock }
    }

    /** One claim column under both releases, however it is addressed. */
    interface Pair {
      write: (db: Db, secondsAgo: number) => Promise<void>
      current: (db: Db) => Promise<boolean>
      before: (db: Db) => Promise<boolean>
    }

    const versionPair = (column: string, current: (schema: string, seconds: number) => string): Pair => ({
      write: async (db, ago) => {
        await db.executeSql(`UPDATE ${ctx.schema}.version SET ${column} = ${ctx.schema}.job_now() - interval '${ago} seconds'`)
      },
      // This release's cron claim answers on both outcomes and says which in a column; the previous
      // one answered with a row only when it took the claim. The two shapes are what makes the
      // reads differ here - the decision they encode is the same, which is what this asserts.
      current: async db => (await db.executeSql(current(ctx.schema, SECONDS))).rows[0]?.claimed === true,
      before: async db => (await db.executeSql(previous.version(column)(ctx.schema, SECONDS))).rows.length === 1
    })

    const queuePair = (
      column: string,
      current: (schema: string, queues: string[], seconds: number) => plans.SqlQuery,
      before: (schema: string, queues: string[], seconds: number) => plans.SqlQuery
    ): Pair => ({
      write: async (db, ago) => {
        await db.executeSql(`UPDATE ${ctx.schema}.queue SET ${column} = ${ctx.schema}.job_now() - interval '${ago} seconds' WHERE name = $1`, ['a'])
      },
      current: async db => {
        const { text, values } = current(ctx.schema, ['a'], SECONDS)
        return (await db.executeSql(text, values)).rows.length === 1
      },
      before: async db => {
        const { text, values } = before(ctx.schema, ['a'], SECONDS)
        return (await db.executeSql(text, values)).rows.length === 1
      }
    })

    // One per statement builder the change touched, rather than one per claim: cron_on and bam_on
    // are the same statement with a different column.
    const pairs = [
      { name: 'cron, on the version row', queues: [] as string[], pair: () => versionPair('cron_on', plans.trySetCronTime) },
      { name: 'maintain, on a queue row', queues: ['a'], pair: () => queuePair('maintain_on', plans.trySetQueueDeletionTime, previous.queue('maintain_on')) },
      { name: 'monitor, on a queue row', queues: ['a'], pair: () => queuePair('monitor_claim_on', plans.trySetQueueMonitorTime, previous.monitor) }
    ]

    for (const { name, queues, pair } of pairs) {
      it(`${name}: the releases agree everywhere except exactly the interval`, async function () {
        const { db } = await quiet(queues)
        const p = pair()

        // Short of the interval, neither release takes it
        await p.write(db, SECONDS - 0.001)
        expect(await p.before(db), 'previous release, a millisecond short').toBe(false)
        expect(await p.current(db), 'this release, a millisecond short').toBe(false)

        // Past it, both do
        await p.write(db, SECONDS + 0.001)
        expect(await p.before(db), 'previous release, a millisecond past').toBe(true)

        await p.write(db, SECONDS + 0.001)
        expect(await p.current(db), 'this release, a millisecond past').toBe(true)

        // And exactly on it, which is the one value they read differently
        await p.write(db, SECONDS)
        expect(await p.before(db), 'previous release, exactly the interval').toBe(false)
        expect(await p.current(db), 'this release, exactly the interval').toBe(true)
      })

      it(`${name}: only one release takes the claim when both try at once`, async function () {
        const { db } = await quiet(queues)
        const p = pair()

        for (let round = 0; round < 3; round++) {
          await p.write(db, SECONDS * 2)

          const taken = await Promise.all([p.before(db), p.current(db), p.before(db), p.current(db)])

          expect(taken.filter(Boolean), `round ${round}`).toHaveLength(1)
        }
      })

      it(`${name}: the claim hands off between the releases in both directions`, async function () {
        const { db } = await quiet(queues)
        const p = pair()

        // Whichever release claims, the other is refused straight after: a pass is never run
        // twice in one interval by a mixed deployment.
        await p.write(db, SECONDS * 2)
        expect(await p.before(db), 'previous release takes an old row').toBe(true)
        expect(await p.current(db), 'this release, straight after').toBe(false)

        await p.write(db, SECONDS * 2)
        expect(await p.current(db), 'this release takes an old row').toBe(true)
        expect(await p.before(db), 'previous release, straight after').toBe(false)
      })
    }

    it('cron: each release reads back the timestamp the other wrote', async function () {
      // The cron claim answers with the timestamp it replaced, which is how a pass learns how long
      // scheduling was off. A mixed deployment has to hand that across the release boundary intact.
      const { db } = await quiet()

      const cronOn = async () => (await db.executeSql(`SELECT cron_on FROM ${ctx.schema}.version`)).rows[0].cron_on as Date

      await db.executeSql(`UPDATE ${ctx.schema}.version SET cron_on = ${ctx.schema}.job_now() - interval '${SECONDS * 2} seconds'`)

      const byPrevious = await cronOn()
      const current = await db.executeSql(plans.trySetCronTime(ctx.schema, SECONDS))

      expect(current.rows[0].claimed).toBe(true)
      expect(new Date(current.rows[0].priorCronOn).getTime(), 'this release reads what the previous one left').toBe(byPrevious.getTime())

      await db.executeSql(`UPDATE ${ctx.schema}.version SET cron_on = ${ctx.schema}.job_now() - interval '${SECONDS * 2} seconds'`)

      const byCurrent = await cronOn()
      const before = await db.executeSql(previous.cron(ctx.schema, SECONDS))

      expect(before.rows).toHaveLength(1)
      expect(new Date(before.rows[0].priorCronOn).getTime(), 'and the previous release reads this one back').toBe(byCurrent.getTime())
    })
  })

  describe('against a real clock', function () {
    it('still lets exactly one of several instances take a claim', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false, supervise: false, noDefault: true })

      const db = ctx.boss.getDb() as Db

      await db.executeSql(`UPDATE ${ctx.schema}.version SET cron_on = now() - interval '60 seconds'`)

      const results = await Promise.all([1, 2, 3].map(async () =>
        (await db.executeSql(plans.trySetCronTime(ctx.schema, 30))).rows[0].claimed === true))

      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('covers the deployment when the instance holding the cron claim stops', async function () {
      // A refused claim used to re-arm an interval after its own failure, so the deployment's next
      // pass was an interval after whenever the losing instance happened to try - up to two
      // intervals after the pass that beat it. While the holder keeps running that phase is nobody's
      // business, and the moment it stops it is the deployment's: at the configurable ceiling the
      // gap runs past the 60-second window a cron occurrence is due in, and the occurrences inside
      // the excess are sent by nobody.
      const seconds = 4
      const config = {
        ...ctx.bossConfig,
        noDefault: true,
        supervise: false,
        schedule: true,
        cronMonitorIntervalSeconds: seconds,
        cronWorkerIntervalSeconds: 1
      }

      const holder = await helper.start(config)
      const db = holder.getDb() as Db
      const cronOn = async () => {
        const { rows: [{ cron_on: value }] } = await db.executeSql(`SELECT cron_on FROM ${ctx.schema}.version`)
        return value === null ? null : new Date(value).getTime()
      }

      await helper.until(async () => await cronOn() !== null)

      // Let the row age most of the way through the interval before the second instance tries, which
      // is the phase that used to cost the deployment a second interval. The wait it arms is the
      // same either way: what the fix measures is the row, not the attempt.
      await new Promise(resolve => setTimeout(resolve, seconds * 750))

      ctx.boss = await helper.start(config)

      try {
        // The deploy: the instance that has been running the passes goes away, leaving one whose
        // claim was refused most of an interval ago. Not graceful, and holding its pool open, since
        // the read below is on it.
        await holder.stop({ graceful: false, close: false })

        const peer = await cronOn() as number

        await helper.until(async () => (await cronOn() as number) > peer, seconds * 3000)

        const gap = (await cronOn() as number) - peer

        expect(gap, 'a pass never runs before its interval is up').toBeGreaterThanOrEqual(seconds * 1000)
        // The beat is a second here; the rest of the allowance is the round trip and whatever the
        // machine running this was doing. Two intervals - what this used to be - is 8000.
        expect(gap, `one interval and a beat, not two intervals (${gap}ms)`).toBeLessThan(seconds * 1000 + 2000)
      } finally {
        await holder.stop({ close: true })
      }
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

        if (rows[0].claimed === true) {
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
