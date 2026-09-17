import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import Manager from '../src/manager.ts'
import Timekeeper, { QUEUES } from '../src/timekeeper.ts'
import type Db from '../src/db.ts'
import { TestClock } from '../src/clock.ts'

/**
 * The interval claims: one instance in a deployment runs a pass per interval, decided by a
 * conditional UPDATE on a timestamp column. Every instance tries on a client timer whose period is
 * the interval itself, and two of its ticks land a few milliseconds either side of that period as
 * the server measures it (the timer and the server keep different clocks), so the claim accepts a
 * tick that lands a little short (plans.trySetTimestamp). These tests pin the threshold from both
 * sides for every claim, and what an accepted short tick does and does not change further up.
 *
 * Elapsed time is set by writing the column to `now() - interval`, the way the other suites do. The
 * claim reads its own now() in a later statement, and under a loaded suite the two can be far
 * apart, so a case at the threshold is judged by what the server measured rather than by what was
 * written: a taken claim leaves its own now() in the column, and a refused one is bounded by a
 * now() read just before it. A case the load pushed past its threshold is retried, not failed.
 */

/** The threshold below which a claim is refused: the interval less one second, or a tenth of it. */
function threshold (seconds: number): number {
  return seconds - Math.min(1, seconds / 10)
}

async function withDb<T> (fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await helper.getDb()

  try {
    return await fn(db)
  } finally {
    await db.close()
  }
}

/** The server's clock, so every elapsed time here is measured on the one clock the claim uses. */
async function serverNow (db: Db): Promise<Date> {
  const { rows } = await db.executeSql('SELECT now() AS now')

  return rows[0].now
}

/** `now() - interval` for a number of seconds ago, negative for the future, or NULL. */
function agoSql (secondsAgo: number | null): string {
  return secondsAgo === null ? 'NULL' : `now() - interval '${secondsAgo} seconds'`
}

/**
 * A migrated schema with the given queues and nothing running against it. bam polls (and claims
 * bam_on) the moment an instance starts, so the SQL-level cases stop the instance first and drive
 * the claims themselves.
 */
async function quietSchema (queues: string[] = []) {
  ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false, supervise: false, noDefault: true })

  for (const queue of queues) {
    await ctx.boss.createQueue(queue)
  }

  await ctx.boss.stop()
}

/** One claim column, whichever row it lives on: how to write it, read it, and try the claim. */
interface Column {
  write: (db: Db, secondsAgo: number | null) => Promise<void>
  read: (db: Db) => Promise<Date | null>
  claim: (db: Db, seconds: number) => Promise<boolean>
}

function versionColumn (column: string, claim: (schema: string, seconds: number) => string): Column {
  return {
    write: async (db, ago) => { await db.executeSql(`UPDATE ${ctx.schema}.version SET ${column} = ${agoSql(ago)}`) },
    read: async (db) => (await db.executeSql(`SELECT ${column} FROM ${ctx.schema}.version`)).rows[0][column],
    claim: async (db, seconds) => (await db.executeSql(claim(ctx.schema, seconds))).rows.length === 1
  }
}

function queueColumn (queue: string, column: string, claim: (schema: string, queues: string[], seconds: number) => plans.SqlQuery): Column {
  return {
    write: async (db, ago) => { await db.executeSql(`UPDATE ${ctx.schema}.queue SET ${column} = ${agoSql(ago)} WHERE name = $1`, [queue]) },
    read: async (db) => (await db.executeSql(`SELECT ${column} FROM ${ctx.schema}.queue WHERE name = $1`, [queue])).rows[0][column],
    claim: async (db, seconds) => {
      const { text, values } = claim(ctx.schema, [queue], seconds)

      return (await db.executeSql(text, values)).rows.map(r => r.name).join() === queue
    }
  }
}

/**
 * The claims as the release before this one sends them: the same statements with the threshold at
 * the interval itself. An instance still on that release during a rolling upgrade shares the row
 * with this one, so its statements run against the same state.
 */
const previous = {
  version (column: string) {
    return (schema: string, seconds: number) => `
    UPDATE ${schema}.version
    SET ${column} = ${schema}.job_now()
    WHERE EXTRACT( EPOCH FROM (${schema}.job_now() - COALESCE(${column}, ${schema}.job_now() - interval '1 week') ) ) > ${seconds}
    RETURNING true
  `
  },
  cron (schema: string, seconds: number) {
    return `
    WITH prior AS (
      SELECT cron_on FROM ${schema}.version
    ), claim AS (
      ${previous.version('cron_on')(schema, seconds)}
    )
    SELECT prior.cron_on as "priorCronOn" FROM prior, claim
  `
  },
  queue (column: string) {
    return (schema: string, queues: string[], seconds: number): plans.SqlQuery => ({
      text: `
    UPDATE ${schema}.queue
    SET ${column} = ${schema}.job_now()
    WHERE name = ANY($1::text[])
      AND EXTRACT( EPOCH FROM (${schema}.job_now() - COALESCE(${column}, ${schema}.job_now() - interval '1 week') ) ) > ${seconds}
    RETURNING name
  `,
      values: [queues]
    })
  },
  monitor (schema: string, queues: string[], seconds: number): plans.SqlQuery {
    return {
      text: `
    UPDATE ${schema}.queue
    SET monitor_claim_on = ${schema}.job_now()
    WHERE name = ANY($1::text[])
      AND EXTRACT( EPOCH FROM (${schema}.job_now() - COALESCE(monitor_claim_on, monitor_on, ${schema}.job_now() - interval '1 week') ) ) > ${seconds}
    RETURNING name, NOT EXISTS (SELECT 1 FROM ${schema}.version WHERE monitor_backoff_on > ${schema}.job_now()) as "refreshStats"
  `,
      values: [queues]
    }
  }
}

/**
 * Writes the column `secondsAgo` back, tries the claim, and checks the outcome against what the
 * server measured. A claim that was taken must have seen more than the threshold, and one that was
 * refused must not have been offered more than the threshold before it ran. The expected outcome
 * is then checked too, except when the suite's own latency carried a case meant to be refused past
 * the threshold, which says nothing about the claim and is retried.
 */
async function probe (db: Db, col: Column, seconds: number, secondsAgo: number | null, expectTaken: boolean, label: string, t = threshold(seconds)) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await col.write(db, secondsAgo)

    const before = await col.read(db)
    const lower = await serverNow(db)
    const taken = await col.claim(db, seconds)
    const after = await col.read(db)

    if (taken) {
      // The column now holds the moment of the claim, so this is the elapsed time it measured
      expect(after, label).toBeInstanceOf(Date)

      if (before === null) {
        expect(expectTaken, `${label}: a never-claimed column is always taken`).toBe(true)

        return
      }

      const measured = (after!.getTime() - before.getTime()) / 1000

      expect(measured, `${label}: taken after ${measured}s, threshold ${t}s`).toBeGreaterThan(t)

      if (expectTaken) return

      // Meant to be refused, but the statements were far enough apart that it was rightly taken
      continue
    }

    // A refused claim writes nothing
    expect(after?.getTime() ?? null, label).toBe(before?.getTime() ?? null)

    const offered = before === null ? Infinity : (lower.getTime() - before.getTime()) / 1000

    expect(offered, `${label}: refused although ${offered}s had passed, threshold ${t}s`).toBeLessThanOrEqual(t)
    expect(expectTaken, `${label}: refused`).toBe(false)

    return
  }

  throw new Error(`${label}: the statements never ran close enough together to test the threshold`)
}

/** The claims on the version row, which take (schema, seconds) and answer with a row when taken. */
const versionClaims = [
  { name: 'cron', column: 'cron_on', claim: plans.trySetCronTime },
  { name: 'bam', column: 'bam_on', claim: plans.trySetBamTime },
  { name: 'flow', column: 'flow_on', claim: plans.trySetFlowTime },
  { name: 'reindex', column: 'reindex_on', claim: plans.trySetReindexTime }
]

/** The claims on queue rows, which take (schema, names, seconds) and answer with the names taken. */
const queueClaims = [
  { name: 'maintain', column: 'maintain_on', claim: plans.trySetQueueDeletionTime },
  { name: 'monitor', column: 'monitor_claim_on', claim: plans.trySetQueueMonitorTime }
]

/**
 * Elapsed times relative to an interval N with threshold T, partitioned by what the claim does with
 * them.
 */
function elapsedCases (seconds: number) {
  const t = threshold(seconds)

  return [
    { label: 'never claimed (NULL)', ago: null, taken: true },
    { label: 'in the future', ago: -5, taken: false },
    { label: 'well inside the interval', ago: t / 2, taken: false },
    { label: 'half a second below the threshold', ago: t - 0.5, taken: false },
    { label: 'just above the threshold, still short of the interval', ago: t + 0.1, taken: true },
    { label: 'the interval itself', ago: seconds, taken: true },
    { label: 'twice the interval', ago: seconds * 2, taken: true },
    { label: 'older than the COALESCE fallback', ago: 8 * 24 * 60 * 60, taken: true }
  ]
}

/**
 * Intervals partitioned by how the threshold is derived: a tenth of the interval below ten seconds,
 * one second from ten seconds up. The ends are the ends the configuration allows: the half-second
 * flow interval tests may set, one second (the cron floor), the 45-second cron ceiling, and 24
 * hours (the reindex and maintenance ceiling).
 */
const intervals = [0.5, 1, 5, 10, 30, 45, 24 * 60 * 60]

describe('interval claims', function () {
  for (const { name, column, claim } of versionClaims) {
    describe(`${name} claim on version.${column}`, function () {
      it(`${name} claim on the version row is taken or refused by how long ago it was last taken`, async function () {
        await quietSchema()

        await withDb(async (db) => {
          const col = versionColumn(column, claim)

          for (const { label, ago, taken } of elapsedCases(30)) {
            await probe(db, col, 30, ago, taken, label)
          }
        })
      })

      it(`${name} claim on the version row sits its threshold a tenth below the interval up to ten seconds, and a second below from there`, async function () {
        await quietSchema()

        await withDb(async (db) => {
          const col = versionColumn(column, claim)

          for (const seconds of intervals) {
            await probe(db, col, seconds, threshold(seconds) - 0.5, false, `${seconds}s, half a second below`)
            await probe(db, col, seconds, threshold(seconds) + 0.1, true, `${seconds}s, just above`)
          }
        })
      })

      // For cron this is already scheduleMissedTest 'answers the cron claim with the timestamp it replaced'
      if (name !== 'cron') {
        it(`${name} claim on the version row is refused straight after being taken, and taken again once the interval has passed`, async function () {
          await quietSchema()

          await withDb(async (db) => {
            const col = versionColumn(column, claim)

            await col.write(db, null)

            expect(await col.claim(db, 30)).toBe(true)
            expect(await col.claim(db, 30)).toBe(false)

            await col.write(db, 31)

            expect(await col.claim(db, 30)).toBe(true)
          })
        })
      }

      it(`${name} claim on the version row is taken by exactly one of several instances trying at once`, async function () {
        await quietSchema()

        await withDb(async (db) => {
          const col = versionColumn(column, claim)

          // Inside the tolerance rather than on a never-claimed row, since that is the new ground:
          // the row lock and the re-check under READ COMMITTED are what keep two accepted short
          // ticks from both running a pass.
          await col.write(db, threshold(30) + 0.1)

          const results = await Promise.all([1, 2, 3].map(() => col.claim(db, 30)))

          expect(results.filter(Boolean)).toHaveLength(1)
        })
      })
    })
  }

  describe('cron claim answers with the timestamp it replaced', function () {
    it('on a tick inside the tolerance, and null when no pass has run', async function () {
      await quietSchema()

      await withDb(async (db) => {
        const col = versionColumn('cron_on', plans.trySetCronTime)

        await col.write(db, null)

        const first = await db.executeSql(plans.trySetCronTime(ctx.schema, 30))

        expect(first.rows).toHaveLength(1)
        expect(first.rows[0].priorCronOn).toBeNull()

        await col.write(db, threshold(30) + 0.1)

        const prior = await col.read(db)

        const short = await db.executeSql(plans.trySetCronTime(ctx.schema, 30))

        expect(short.rows).toHaveLength(1)
        expect(new Date(short.rows[0].priorCronOn).getTime()).toBe(prior!.getTime())
      })
    })
  })

  for (const { name, column, claim } of queueClaims) {
    describe(`${name} claim on queue.${column}`, function () {
      it(`${name} claim on a queue row is taken or refused by how long ago it was last taken`, async function () {
        await quietSchema(['a'])

        await withDb(async (db) => {
          const col = queueColumn('a', column, claim)

          for (const { label, ago, taken } of elapsedCases(30)) {
            await probe(db, col, 30, ago, taken, label)
          }
        })
      })

      it(`${name} claim on a queue row sits its threshold a tenth below the interval up to ten seconds, and a second below from there`, async function () {
        await quietSchema(['a'])

        await withDb(async (db) => {
          const col = queueColumn('a', column, claim)

          for (const seconds of intervals) {
            await probe(db, col, seconds, threshold(seconds) - 0.5, false, `${seconds}s, half a second below`)
            await probe(db, col, seconds, threshold(seconds) + 0.1, true, `${seconds}s, just above`)
          }
        })
      })

      it(`${name} claim on a queue row takes only the queues that are due, and none it was not asked about`, async function () {
        await quietSchema(['due', 'fresh', 'unasked'])

        await withDb(async (db) => {
          const due = queueColumn('due', column, claim)
          const fresh = queueColumn('fresh', column, claim)
          const unasked = queueColumn('unasked', column, claim)

          await due.write(db, threshold(30) + 0.1)
          await fresh.write(db, threshold(30) / 2)
          await unasked.write(db, 3600)

          const freshBefore = await fresh.read(db)
          const unaskedBefore = await unasked.read(db)

          const { text, values } = claim(ctx.schema, ['due', 'fresh'], 30)
          const { rows } = await db.executeSql(text, values)

          expect(rows.map(r => r.name)).toEqual(['due'])
          expect((await fresh.read(db))!.getTime()).toBe(freshBefore!.getTime())
          expect((await unasked.read(db))!.getTime()).toBe(unaskedBefore!.getTime())

          const none = claim(ctx.schema, [], 30)

          expect((await db.executeSql(none.text, none.values)).rows).toHaveLength(0)

          const unknown = claim(ctx.schema, ['no-such-queue'], 30)

          expect((await db.executeSql(unknown.text, unknown.values)).rows).toHaveLength(0)
        })
      })

      it(`${name} claim on a queue row is taken by exactly one of several instances trying at once`, async function () {
        await quietSchema(['a'])

        await withDb(async (db) => {
          const col = queueColumn('a', column, claim)

          await col.write(db, threshold(30) + 0.1)

          const results = await Promise.all([1, 2, 3].map(() => col.claim(db, 30)))

          expect(results.filter(Boolean)).toHaveLength(1)
        })
      })
    })
  }

  describe('monitor claim reads monitor_on when it has never claimed', function () {
    // Which column the elapsed time is measured from, for every combination of the two being set.
    // Fresh values sit at half the threshold so the outcome does not depend on how quickly the
    // statements follow each other.
    const t = threshold(60)
    const cases = [
      { claimOn: null, monitorOn: null, taken: true, reads: 'neither, so the fallback week' },
      { claimOn: null, monitorOn: t + 0.1, taken: true, reads: 'monitor_on, which is due' },
      { claimOn: null, monitorOn: t / 2, taken: false, reads: 'monitor_on, which is fresh' },
      { claimOn: t / 2, monitorOn: 3600, taken: false, reads: 'monitor_claim_on, which is fresh, over a due monitor_on' },
      { claimOn: t + 0.1, monitorOn: 1, taken: true, reads: 'monitor_claim_on, which is due, over a fresh monitor_on' }
    ]

    it('measures from monitor_claim_on, then monitor_on, then the fallback week', async function () {
      await quietSchema(['a'])

      await withDb(async (db) => {
        const claimOn = queueColumn('a', 'monitor_claim_on', plans.trySetQueueMonitorTime)
        const monitorOn = queueColumn('a', 'monitor_on', plans.trySetQueueMonitorTime)

        for (const c of cases) {
          await claimOn.write(db, c.claimOn)
          await monitorOn.write(db, c.monitorOn)

          const monitorBefore = await monitorOn.read(db)

          expect(await claimOn.claim(db, 60), c.reads).toBe(c.taken)

          // The claim stamps its own column only; monitor_on is the aggregate's to write
          expect((await monitorOn.read(db))?.getTime() ?? null, c.reads).toBe(monitorBefore?.getTime() ?? null)
        }
      })
    })
  })

  describe('the cron pass behind the claim', function () {
    /** A Timekeeper over the test schema whose passes are counted rather than run. */
    function makeTimekeeper (db: Db, seconds: number) {
      const config = { ...ctx.bossConfig, cronMonitorIntervalSeconds: seconds }
      const manager = new Manager(db, config)
      const tk = new Timekeeper(db, manager, config)
      const passes: unknown[] = []

      manager.timekeeper = tk
      ;(tk as any).stopped = false
      ;(tk as any).cron = async (priorCronOn: unknown) => { passes.push(priorCronOn) }

      return Object.assign(tk, { passes })
    }

    it('runs on a tick that lands inside the tolerance, with the previous pass as its prior, and not on one well inside the interval', async function () {
      await quietSchema()

      await withDb(async (db) => {
        const col = versionColumn('cron_on', plans.trySetCronTime)
        const tk = makeTimekeeper(db, 30)

        await col.write(db, null)

        await tk.onCron()

        expect(tk.passes).toEqual([null])

        await col.write(db, threshold(30) + 0.1)

        const prior = await col.read(db)

        await tk.onCron()

        expect(tk.passes).toHaveLength(2)
        expect(new Date(tk.passes[1] as string).getTime()).toBe(prior!.getTime())

        await col.write(db, threshold(30) / 2)

        await tk.onCron()

        expect(tk.passes).toHaveLength(2)
      })
    })

    it('does not send an occurrence twice when a second pass is accepted inside the same slot', async function () {
      await quietSchema([QUEUES.SEND_IT])

      // Both passes have to file their job in the same minute slot for the second to collide. Two
      // passes a few milliseconds apart do, unless a minute boundary falls between them.
      while (new Date().getSeconds() >= 57) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      await withDb(async (db) => {
        const col = versionColumn('cron_on', plans.trySetCronTime)
        const config = { ...ctx.bossConfig, cronMonitorIntervalSeconds: 30 }
        const manager = new Manager(db, config)
        const tk = new Timekeeper(db, manager, config)

        manager.timekeeper = tk
        ;(tk as any).stopped = false
        ;(tk as any).getSchedules = async () => [{ name: 'q', key: '', data: null, options: {}, kind: plans.SCHEDULE_KINDS.cron, cron: '* * * * *', timezone: 'UTC' }]

        await col.write(db, null)

        await tk.onCron()

        await col.write(db, threshold(30) + 0.1)

        const wrote = await col.read(db)

        await tk.onCron()

        // The second pass has to have run for the check below to mean anything: its claim moved the
        // column, so this is not the strict comparison refusing it and sending nothing
        expect((await col.read(db))!.getTime(), 'the second pass took the claim').toBeGreaterThan(wrote!.getTime())

        const { rows } = await db.executeSql(`SELECT count(*)::int AS c FROM ${ctx.schema}.job WHERE name = $1`, [QUEUES.SEND_IT])

        expect(rows[0].c).toBe(1)
      })
    })
  })

  describe('alongside an instance on the previous release', function () {
    /** Both releases' statements for one column, on the row they share. */
    interface Pair { name: string, seconds: number, current: Column, before: Column, currentThreshold: number, beforeThreshold: number }

    function versionPair (name: string, column: string, claim: (schema: string, seconds: number) => string, seconds = 30): Pair {
      return { name, seconds, current: versionColumn(column, claim), before: versionColumn(column, previous.version(column)), currentThreshold: threshold(seconds), beforeThreshold: seconds }
    }

    function queuePair (name: string, queue: string, column: string, claim: (schema: string, queues: string[], seconds: number) => plans.SqlQuery, seconds = 30): Pair {
      const old = column === 'monitor_claim_on' ? previous.monitor : previous.queue(column)

      return { name, seconds, current: queueColumn(queue, column, claim), before: queueColumn(queue, column, old), currentThreshold: threshold(seconds), beforeThreshold: seconds }
    }

    const versionPairs = () => versionClaims.map(c => versionPair(c.name, c.column, c.claim))
    const queuePairs = () => queueClaims.map(c => queuePair(c.name, 'a', c.column, c.claim))

    const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim()

    it('sends the same statements as this release with the threshold at the interval', function () {
      const seconds = 30
      const t = threshold(seconds)

      for (const { column, claim } of versionClaims) {
        expect(squash(claim('s', seconds)).replace(`> ${t}`, `> ${seconds}`)).toBe(squash(column === 'cron_on' ? previous.cron('s', seconds) : previous.version(column)('s', seconds)))
      }

      for (const { column, claim } of queueClaims) {
        const now = claim('s', ['a'], seconds)
        const then = column === 'monitor_claim_on' ? previous.monitor('s', ['a'], seconds) : previous.queue(column)('s', ['a'], seconds)

        expect(squash(now.text).replace(`> ${t}`, `> ${seconds}`)).toBe(squash(then.text))
        expect(now.values).toEqual(then.values)
      }
    })

    /** Every state the shared row can be in, and what each release does with it. */
    async function matrix (db: Db, pair: Pair) {
      const { seconds, current, before, currentThreshold, beforeThreshold } = pair
      const band = currentThreshold + 0.1

      // This release's own states are the first group of tests; here only the previous release's,
      // which differ in the one band this release accepts and it does not
      await probe(db, before, seconds, null, true, 'previous: never claimed', beforeThreshold)
      await probe(db, before, seconds, -5, false, 'previous: in the future', beforeThreshold)
      await probe(db, before, seconds, currentThreshold / 2, false, 'previous: well inside', beforeThreshold)
      await probe(db, before, seconds, band, false, 'previous: inside the band this release accepts', beforeThreshold)
      await probe(db, before, seconds, seconds + 0.1, true, 'previous: just past the interval', beforeThreshold)
      await probe(db, before, seconds, seconds * 2, true, 'previous: twice the interval', beforeThreshold)

      // Straight after the other release took it, whichever release that was
      await before.write(db, seconds * 2)
      expect(await before.claim(db, seconds), 'previous takes an old row').toBe(true)
      expect(await current.claim(db, seconds), 'current, straight after previous took it').toBe(false)

      await current.write(db, seconds * 2)
      expect(await current.claim(db, seconds), 'current takes an old row').toBe(true)
      expect(await before.claim(db, seconds), 'previous, straight after current took it').toBe(false)
    }

    for (const p of versionPairs()) {
      it(`${p.name}: each release on the version row takes or refuses by its own threshold, whichever release last took it`, async function () {
        await quietSchema()
        await withDb(async (db) => await matrix(db, p))
      })
    }

    for (const p of queuePairs()) {
      it(`${p.name}: each release on a queue row takes or refuses by its own threshold, whichever release last took it`, async function () {
        await quietSchema(['a'])
        await withDb(async (db) => await matrix(db, p))
      })
    }

    /** Both releases trying at the same instant: the row lock lets one through, whatever the predicates. */
    async function together (db: Db, pair: Pair) {
      const { seconds, current, before, currentThreshold } = pair

      for (let round = 0; round < 3; round++) {
        await current.write(db, seconds * 2)

        const results = await Promise.all([before, current, before, current].map(col => col.claim(db, seconds)))

        expect(results.filter(Boolean), `round ${round}, both eligible`).toHaveLength(1)

        await current.write(db, currentThreshold + 0.1)

        const wrote = await current.read(db)
        const [tookBefore, tookCurrent] = await Promise.all([before.claim(db, seconds), current.claim(db, seconds)])
        const after = await current.read(db)

        expect([tookBefore, tookCurrent].filter(Boolean), `round ${round}, inside the band`).toHaveLength(1)

        if (tookBefore) {
          // Only possible when the statements ran far enough apart to leave the band
          expect((after!.getTime() - wrote!.getTime()) / 1000, `round ${round}, previous took inside the band`).toBeGreaterThan(seconds)
        }
      }
    }

    for (const p of versionPairs()) {
      it(`${p.name}: exactly one of the two releases trying at once on the version row is taken`, async function () {
        await quietSchema()
        await withDb(async (db) => await together(db, p))
      })
    }

    for (const p of queuePairs()) {
      it(`${p.name}: exactly one of the two releases trying at once on a queue row is taken`, async function () {
        await quietSchema(['a'])
        await withDb(async (db) => await together(db, p))
      })
    }

    /** The claim moving between releases over a sequence of ticks, in both directions. */
    async function handoff (db: Db, pair: Pair) {
      const { seconds, current, before, currentThreshold, beforeThreshold } = pair
      const band = currentThreshold + 0.1

      const steps: Array<[string, Column, number | null, boolean, number]> = [
        ['previous takes a never-claimed row', before, null, true, beforeThreshold],
        ['current, straight after, is refused', current, 0, false, currentThreshold],
        ['current takes inside the band', current, band, true, currentThreshold],
        ['previous, straight after, is refused', before, 0, false, beforeThreshold],
        ['previous inside the band is still refused', before, band, false, beforeThreshold],
        ['previous takes once the interval has passed', before, seconds + 0.1, true, beforeThreshold],
        ['current takes inside the band again', current, band, true, currentThreshold],
        ['current, straight after itself, is refused', current, 0, false, currentThreshold]
      ]

      for (const [label, col, since, taken, t] of steps) {
        if (since === 0) {
          expect(await col.claim(db, seconds), label).toBe(taken)
        } else {
          await probe(db, col, seconds, since, taken, label, t)
        }
      }
    }

    for (const p of versionPairs()) {
      it(`${p.name}: the claim moves between releases on the version row in both directions`, async function () {
        await quietSchema()
        await withDb(async (db) => await handoff(db, p))
      })
    }

    for (const p of queuePairs()) {
      it(`${p.name}: the claim moves between releases on a queue row in both directions`, async function () {
        await quietSchema(['a'])
        await withDb(async (db) => await handoff(db, p))
      })
    }

    it('a pass on this release runs inside the band after the previous release claimed, each release answering with the timestamp the other wrote', async function () {
      await quietSchema()

      await withDb(async (db) => {
        const config = { ...ctx.bossConfig, cronMonitorIntervalSeconds: 30 }
        const manager = new Manager(db, config)
        const tk = new Timekeeper(db, manager, config)
        const passes: unknown[] = []

        manager.timekeeper = tk
        ;(tk as any).stopped = false
        ;(tk as any).cron = async (priorCronOn: unknown) => { passes.push(priorCronOn) }

        const col = versionColumn('cron_on', previous.cron)

        await col.write(db, null)

        const first = await db.executeSql(previous.cron(ctx.schema, 30))

        expect(first.rows).toHaveLength(1)
        expect(first.rows[0].priorCronOn).toBeNull()

        // Straight after, and well inside the interval, this release's pass does not run
        await tk.onCron()

        expect(passes).toHaveLength(0)

        await col.write(db, threshold(30) / 2)

        await tk.onCron()

        expect(passes).toHaveLength(0)

        // Inside the band it runs, with the previous release's claim as the prior it reports
        await col.write(db, threshold(30) + 0.1)

        const byPrevious = await col.read(db)

        await tk.onCron()

        expect(passes).toHaveLength(1)
        expect(new Date(passes[0] as string).getTime()).toBe(byPrevious!.getTime())

        // And the previous release, once its own interval has passed, reads this release's claim back
        await col.write(db, 31)

        const byCurrent = await col.read(db)
        const third = await db.executeSql(previous.cron(ctx.schema, 30))

        expect(third.rows).toHaveLength(1)
        expect(new Date(third.rows[0].priorCronOn).getTime()).toBe(byCurrent!.getTime())
      })
    })

    for (const { name, column, claim } of queueClaims) {
      it(`${name}: each release takes only the queues due by its own threshold out of a mixed set`, async function () {
        await quietSchema(['a', 'b', 'c'])

        await withDb(async (db) => {
          const old = column === 'monitor_claim_on' ? previous.monitor : previous.queue(column)
          const names = (rows: any[]) => rows.map(r => r.name).sort()

          const a = queueColumn('a', column, old)

          await a.write(db, 60)
          expect(await a.claim(db, 30), 'previous takes a').toBe(true)

          await queueColumn('b', column, claim).write(db, threshold(30) + 0.1)
          await queueColumn('c', column, claim).write(db, null)

          const now = claim(ctx.schema, ['a', 'b', 'c'], 30)

          expect(names((await db.executeSql(now.text, now.values)).rows)).toEqual(['b', 'c'])

          const then = old(ctx.schema, ['a', 'b', 'c'], 30)

          expect(names((await db.executeSql(then.text, then.values)).rows)).toEqual([])

          await a.write(db, 30.1)

          expect(names((await db.executeSql(then.text, then.values)).rows)).toEqual(['a'])
        })
      })
    }

    it('monitor: a row a release before monitor_claim_on left is read the same way by both releases', async function () {
      await quietSchema(['a'])

      await withDb(async (db) => {
        const claimOn = queueColumn('a', 'monitor_claim_on', plans.trySetQueueMonitorTime)
        const monitorOn = queueColumn('a', 'monitor_on', plans.trySetQueueMonitorTime)
        const oldClaimOn = queueColumn('a', 'monitor_claim_on', previous.monitor)

        await claimOn.write(db, null)
        await monitorOn.write(db, threshold(60) + 0.1)

        expect(await oldClaimOn.claim(db, 60), 'previous, monitor_on inside the band').toBe(false)
        expect(await claimOn.claim(db, 60), 'current, monitor_on inside the band').toBe(true)

        await claimOn.write(db, null)
        await monitorOn.write(db, 61)

        expect(await oldClaimOn.claim(db, 60), 'previous, monitor_on past the interval').toBe(true)
        expect(await claimOn.claim(db, 60), 'current, straight after').toBe(false)
      })
    })

    it('releases configured with different intervals each judge by their own', async function () {
      await quietSchema()

      await withDb(async (db) => {
        const before30 = versionColumn('cron_on', previous.version('cron_on'))
        const current45 = versionColumn('cron_on', plans.trySetCronTime)

        await probe(db, before30, 30, 31, true, 'previous at 30s, 31s ago', 30)
        await probe(db, current45, 45, 40, false, 'current at 45s, 40s ago', threshold(45))
        await probe(db, current45, 45, threshold(45) + 0.1, true, 'current at 45s, inside its band', threshold(45))
        expect(await before30.claim(db, 30), 'previous at 30s, straight after').toBe(false)

        const before45 = versionColumn('cron_on', previous.version('cron_on'))
        const current30 = versionColumn('cron_on', plans.trySetCronTime)

        await probe(db, current30, 30, threshold(30) + 0.1, true, 'current at 30s, inside its band', threshold(30))
        expect(await before45.claim(db, 45), 'previous at 45s, straight after').toBe(false)
        await probe(db, before45, 45, threshold(45) + 0.1, false, 'previous at 45s, inside the band it does not accept', 45)
        await probe(db, current30, 30, 44.2, true, 'current at 30s, 44.2s ago', threshold(30))
      })
    })
  })

  describe('supervise() behind the queue claims', function () {
    it('does not monitor again on a call inside the interval, and does on one inside the tolerance', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, noDefault: true, persistQueueStats: true, monitorIntervalSeconds: 60 })
      await ctx.boss.createQueue('a')
      await ctx.boss.send('a')

      const count = async () => await withDb(async (db) => {
        const { rows } = await db.executeSql(`SELECT count(*)::int AS c FROM ${ctx.schema}.queue_stats WHERE name = 'a'`)

        return rows[0].c as number
      })

      await ctx.boss.supervise('a')
      await ctx.boss.supervise('a')

      // docs/api/ops.md: steps within a pass are rate-limited by their own intervals, so a second
      // call inside monitorIntervalSeconds records nothing
      expect(await count()).toBe(1)

      // An instance whose tick lands inside the tolerance takes the claim and records a sample. In a
      // deployment this is one extra sample when the claiming instance changes, and it is the price
      // of no longer refusing every tick that lands a few milliseconds short.
      await withDb(async (db) => await queueColumn('a', 'monitor_claim_on', plans.trySetQueueMonitorTime).write(db, threshold(60) + 0.1))

      await ctx.boss.supervise('a')

      expect(await count()).toBe(2)
    })
  })

  /**
   * On a TestClock a tick lands exactly one interval after the one before it, on the JavaScript
   * side and, through job_now(), on the server's: the elapsed time the claim measures is the
   * interval to the microsecond, with none of the jitter a real timer adds. Compared strictly, that
   * is the one value the claim refuses every time, so a pass ran on every other tick.
   */
  describe('on a TestClock', function () {
    const START = '2026-01-01T00:00:00Z'

    const fakeAgoSql = (seconds: number) => `${ctx.schema}.job_now() - interval '${seconds} seconds'`

    async function startFrozen (config: object) {
      const clock = new TestClock(START)

      const boss = await helper.start({ ...ctx.bossConfig, clock, ...config })

      ctx.boss = boss

      return { boss, clock, db: boss.getDb() as Db }
    }

    async function readClaims (db: Db, queue: string) {
      const { rows: [version] } = await db.executeSql(`SELECT cron_on, bam_on, flow_on FROM ${ctx.schema}.version`)
      const { rows: [q] } = await db.executeSql(`SELECT monitor_claim_on FROM ${ctx.schema}.queue WHERE name = $1`, [queue])

      const at = (d: Date | null) => d ? d.getTime() : null

      return { cron: at(version.cron_on), bam: at(version.bam_on), flow: at(version.flow_on), monitor: at(q?.monitor_claim_on ?? null) }
    }

    for (const { name, column, claim } of versionClaims) {
      it(`${name}: exactly the interval is taken and exactly the threshold is refused, on a frozen clock`, async function () {
        const { db } = await startFrozen({ schedule: false, supervise: false, noDefault: true })
        // bam polls once as the instance starts (it runs whenever `migrate` is on) and claims bam_on;
        // let that land before writing the column. Nothing else runs: no schedule, no supervise, and
        // no tick ever comes on this clock.
        await helper.until(async () => (await readClaims(db, '')).bam !== null)

        const col = versionColumn(column, claim)
        const seconds = 30
        const t = threshold(seconds)

        for (const [ago, taken, label] of [[seconds, true, 'exactly the interval'], [t, false, 'exactly the threshold'], [t + 0.001, true, 'a millisecond past the threshold']] as const) {
          await db.executeSql(`UPDATE ${ctx.schema}.version SET ${column} = ${fakeAgoSql(ago)}`)

          expect(await col.claim(db, seconds), label).toBe(taken)

          const after = await col.read(db)

          expect(after!.getTime(), `${label}: the column afterwards`).toBe(new Date(START).getTime() - (taken ? 0 : ago * 1000))
        }
      })
    }

    for (const { name, column, claim } of queueClaims) {
      it(`${name}: exactly the interval is taken and exactly the threshold is refused on a queue row, on a frozen clock`, async function () {
        const { boss, db } = await startFrozen({ schedule: false, supervise: false, noDefault: true })

        await boss.createQueue('a')

        const col = queueColumn('a', column, claim)
        const seconds = 30
        const t = threshold(seconds)

        for (const [ago, taken, label] of [[seconds, true, 'exactly the interval'], [t, false, 'exactly the threshold'], [t + 0.001, true, 'a millisecond past the threshold']] as const) {
          await db.executeSql(`UPDATE ${ctx.schema}.queue SET ${column} = ${fakeAgoSql(ago)} WHERE name = $1`, ['a'])

          expect(await col.claim(db, seconds), label).toBe(taken)

          const after = await col.read(db)

          expect(after!.getTime(), `${label}: the column afterwards`).toBe(new Date(START).getTime() - (taken ? 0 : ago * 1000))
        }
      })
    }

    it('an every-minute schedule at the 45-second ceiling sends every occurrence, tick after tick', async function () {
      // Ten seconds past the minute, so no pass lands on a minute boundary: a pass at exactly :00.000
      // would file the occurrence prev() returns under the minute it runs in rather than its own.
      const seconds = 45
      const clock = new TestClock('2026-01-01T00:00:10Z')
      const boss = await helper.start({ ...ctx.bossConfig, clock, schedule: true, supervise: false, cronMonitorIntervalSeconds: seconds })

      ctx.boss = boss

      const db = boss.getDb() as Db
      const t0 = clock.now()
      const minute = new Date('2026-01-01T00:00:00Z').getTime()

      await boss.createQueue('q')
      await boss.schedule('q', '* * * * *')

      // The pass the instance runs as it starts claims at t0; let it land before the clock moves,
      // or its claim is stamped with whatever time the first tick has pushed by then
      await helper.until(async () => (await readClaims(db, 'q')).cron === t0)

      // The minutes the send-it rows were filed under, counted from midnight
      const slots = async () => {
        // singleton_on is a timestamp without time zone holding UTC, so read it as epoch seconds
        // rather than through the driver's local-time parse
        const { rows } = await db.executeSql(`SELECT EXTRACT(EPOCH FROM singleton_on)::float8 AS at FROM ${ctx.schema}.job WHERE name = $1 ORDER BY singleton_on`, [QUEUES.SEND_IT])

        return rows.map(r => (Number(r.at) * 1000 - minute) / 60000)
      }

      // Passes at :55, 1:40, 2:25 and 3:10 each find the occurrence of their own minute. Compared
      // strictly, the passes at :55 and 2:25 lose the claim and 00:00 and 00:02 are not sent.
      const expected = [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3]]

      for (let i = 1; i <= 4; i++) {
        await clock.tick(seconds * 1000)

        // Give the pass the tick started time to file its row, then judge by what was filed
        await helper.until(async () => (await slots()).length >= expected[i - 1].length, 3000).catch(() => {})

        expect(await slots(), `after tick ${i} (clock at +${i * seconds}s)`).toEqual(expected[i - 1])
      }
    })

    it('every claim that runs on a tick keeps up with the clock, tick after tick', async function () {
      // One period for all of them, so each tick is exactly one interval for every claim at once.
      const seconds = 30
      const { boss, clock, db } = await startFrozen({
        schedule: true,
        supervise: true,
        cronMonitorIntervalSeconds: seconds,
        bamIntervalSeconds: seconds,
        flowIntervalSeconds: seconds,
        superviseIntervalSeconds: seconds,
        monitorIntervalSeconds: seconds
      })

      await boss.createQueue('q')

      const t0 = new Date(START).getTime()

      // cron, bam and flow each try once as they start; supervise first runs on its first tick.
      await helper.until(async () => {
        const c = await readClaims(db, 'q')
        return c.cron === t0 && c.bam === t0 && c.flow === t0
      })

      for (let i = 1; i <= 4; i++) {
        // A tick that lands while the previous pass is still running is dropped, by design
        // (#onSupervise and onCron both return when a pass is in flight), so wait for the instance
        // to go quiet before the next one. supervise() is the long pass and says when it is done;
        // the others end with a couple of reads on an empty schema.
        await helper.until(() => !boss.isMaintaining())
        await new Promise(resolve => setTimeout(resolve, 100))

        await clock.tick(seconds * 1000)

        const expected = t0 + i * seconds * 1000

        await helper.until(async () => {
          const c = await readClaims(db, 'q')
          return c.cron === expected && c.bam === expected && c.flow === expected && c.monitor === expected
        }, 3000).catch(async () => {
          const c = await readClaims(db, 'q')
          throw new Error(`after tick ${i} (clock at +${i * seconds}s): cron +${(c.cron! - t0) / 1000}s, bam +${(c.bam! - t0) / 1000}s, flow +${(c.flow! - t0) / 1000}s, monitor ${c.monitor === null ? 'null' : `+${(c.monitor - t0) / 1000}s`}`)
        })
      }
    })
  })
})
