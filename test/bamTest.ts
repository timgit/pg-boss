import { describe, it } from 'vitest'
import pg from 'pg'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import Bam from '../src/bam.ts'
import Db from '../src/db.ts'
import { systemClock } from '../src/clock.ts'
import { PgBoss, TestClock } from '../src/index.ts'
import { delay } from '../src/tools.ts'

const bamConfig = {
  noDefault: true,
  bamIntervalSeconds: 1,
  __test__bypass_bam_interval_check: true
}

async function insertBamCommand (schema: string, name: string, command: string) {
  const db = await helper.getDb()
  await db.executeSql(`
    INSERT INTO ${schema}.bam (name, version, status, table_name, command)
    VALUES ($1, 27, 'pending', 'job_common', $2)
  `, [name, command])
  await db.close()
}

async function insertBamRow (schema: string, name: string, status: string, command: string, startedAgoSeconds?: number, error?: string) {
  const db = await helper.getDb()
  const startedOn = startedAgoSeconds != null ? `now() - interval '${startedAgoSeconds} seconds'` : 'NULL'
  const { rows } = await db.executeSql(`
    INSERT INTO ${schema}.bam (name, version, status, table_name, command, started_on, error)
    VALUES ($1, 27, $2, 'job_common', $3, ${startedOn}, $4)
    RETURNING started_on as "startedOn"
  `, [name, status, command, error ?? null])
  await db.close()

  return rows[0].startedOn
}

async function insertBamRowOnTable (schema: string, name: string, status: string, command: string, tableName: string, startedAgoSeconds?: number) {
  const db = await helper.getDb()
  const startedOn = startedAgoSeconds != null ? `now() - interval '${startedAgoSeconds} seconds'` : 'NULL'
  await db.executeSql(`
    INSERT INTO ${schema}.bam (name, version, status, table_name, command, started_on)
    VALUES ($1, 27, $2, $4, $3, ${startedOn})
  `, [name, status, command, tableName])
  await db.close()
}

async function triggerBamPoll (schema: string) {
  // Reset bam_on to allow processing on next poll cycle
  const db = await helper.getDb()
  await db.executeSql(`UPDATE ${schema}.version SET bam_on = NULL`)
  await db.close()
}

async function pollBamRow (schema: string, name: string, done: (row: any) => boolean, label: string, timeoutMs = 5000) {
  const db = await helper.getDb()
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { rows } = await db.executeSql(
        `SELECT status, started_on as "startedOn" FROM ${schema}.bam WHERE name = $1`, [name]
      )
      if (rows[0] && done(rows[0])) return rows[0]
      await delay(50)
    }
    throw new Error(`Timeout waiting for bam row: ${name} ${label}`)
  } finally {
    await db.close()
  }
}

function waitForBamStatus (schema: string, name: string, status: string, timeoutMs = 5000) {
  return pollBamRow(schema, name, row => row.status === status, status, timeoutMs)
}

function waitForBamClaim (schema: string, name: string, priorStartedOn: Date, timeoutMs = 5000) {
  return pollBamRow(
    schema,
    name,
    row => row.startedOn != null && new Date(row.startedOn).getTime() !== new Date(priorStartedOn).getTime(),
    'claimed',
    timeoutMs
  )
}

function waitForBamEvent (boss: any, name: string, status: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      boss.off('bam', handler)
      reject(new Error(`Timeout waiting for bam event: ${name} ${status}`))
    }, timeoutMs)

    const handler = (event: any) => {
      if (event.name === name && event.status === status) {
        clearTimeout(timeout)
        boss.off('bam', handler)
        resolve(event)
      }
    }
    boss.on('bam', handler)
  })
}

describe('bam', function () {
  describe('poll error handling', function () {
    it('should emit error when poll throws', async function () {
      const errorMessage = 'test bam poll error'
      const config = {
        ...ctx.bossConfig,
        noDefault: true,
        bamIntervalSeconds: 1,
        __test__bypass_bam_interval_check: true,
        __test__throw_bam: errorMessage
      }

      ctx.boss = new PgBoss(config)

      let errorCount = 0
      const errors: Error[] = []

      ctx.boss.on('error', (error: Error) => {
        errors.push(error)
        errorCount++
      })

      await ctx.boss.start()
      await delay(1500)

      expect(errorCount).toBeGreaterThanOrEqual(1)
      expect(errors.some(e => e.message === errorMessage)).toBe(true)
    })
  })

  describe('command error handling', function () {
    it('should mark command as failed when execution throws', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      // Suppress unhandled error events during test
      boss.on('error', () => {})

      const errorMessage = 'intentional test error'

      await insertBamCommand(
        ctx.schema,
        'test_error_1',
        `DO $$ BEGIN RAISE EXCEPTION '${errorMessage}'; END $$;`
      )

      const bamEventPromise = waitForBamEvent(boss, 'test_error_1', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const bamStatus = await boss.getBamEntries()
      const failedEntry = bamStatus.find((e: any) => e.name === 'test_error_1')

      helper.assertTruthy(failedEntry)
      expect(failedEntry.status).toBe('failed')
      expect(failedEntry.error).toContain(errorMessage)
    }, 10000)

    it('should emit error event when command fails', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })

      const errorMessage = 'test error for event'
      const errors: Error[] = []

      boss.on('error', (err: Error) => {
        errors.push(err)
      })

      await insertBamCommand(
        ctx.schema,
        'test_error_event',
        `DO $$ BEGIN RAISE EXCEPTION '${errorMessage}'; END $$;`
      )

      const bamEventPromise = waitForBamEvent(boss, 'test_error_event', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const relevantError = errors.find(e => e.message.includes(errorMessage))
      expect(relevantError).toBeDefined()
    }, 10000)

    it('should emit bam event with failed status', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const bamEvents: any[] = []
      boss.on('bam', (event: any) => {
        bamEvents.push(event)
      })

      await insertBamCommand(ctx.schema, 'test_bam_event', 'SELECT 1/0')

      const bamEventPromise = waitForBamEvent(boss, 'test_bam_event', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const inProgressEvent = bamEvents.find(e => e.name === 'test_bam_event' && e.status === 'in_progress')
      const failedEvent = bamEvents.find(e => e.name === 'test_bam_event' && e.status === 'failed')

      expect(inProgressEvent).toBeDefined()
      expect(inProgressEvent.table).toBe('job_common')

      expect(failedEvent).toBeDefined()
      expect(failedEvent.table).toBe('job_common')
      expect(failedEvent.error).toBeDefined()
    }, 10000)

    it('should continue processing after a failed command', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`
        INSERT INTO ${ctx.schema}.bam (name, version, status, table_name, command)
        VALUES
          ('test_fail', 27, 'pending', 'job_common', 'SELECT 1/0'),
          ('test_success', 27, 'pending', 'job_other', 'SELECT 1')
      `)
      await db.close()

      const failPromise = waitForBamEvent(boss, 'test_fail', 'failed')
      const successPromise = waitForBamEvent(boss, 'test_success', 'completed', 10000)

      // One poll: the burst moves on to the second command after the first fails. It is on another
      // table, so the failure does not hold it.
      await triggerBamPoll(ctx.schema)
      await failPromise
      await successPromise

      const bamStatus = await boss.getBamEntries()
      const failedEntry = bamStatus.find((e: any) => e.name === 'test_fail')
      const successEntry = bamStatus.find((e: any) => e.name === 'test_success')

      helper.assertTruthy(failedEntry)
      expect(failedEntry.status).toBe('failed')

      helper.assertTruthy(successEntry)
      expect(successEntry.status).toBe('completed')
    }, 15000)

    it('should capture error message for type cast errors', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      await insertBamCommand(ctx.schema, 'test_cast_error', 'SELECT \'not_a_number\'::int')

      const bamEventPromise = waitForBamEvent(boss, 'test_cast_error', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const bamStatus = await boss.getBamEntries()
      const entry = bamStatus.find((e: any) => e.name === 'test_cast_error')

      helper.assertTruthy(entry)
      expect(entry.status).toBe('failed')
      helper.assertTruthy(entry.error)
      expect(entry.error.length).toBeGreaterThan(0)
    }, 10000)
  })

  describe('stale in_progress reclaim', function () {
    it('should reclaim a stale in_progress command and process it', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      // A process that claimed this command died mid-flight, leaving it 'in_progress'. Nothing ever
      // resets it, and getNextBamCommand's NOT EXISTS(in_progress) guard would block every future
      // command behind it. Backdated past BAM_STALE_SECONDS (24h fallback) so it must be reclaimed.
      await insertBamRow(ctx.schema, 'stale_cmd', 'in_progress', 'SELECT 1', 25 * 60 * 60)

      const done = waitForBamEvent(boss, 'stale_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const entry = (await boss.getBamEntries()).find((e: any) => e.name === 'stale_cmd')
      helper.assertTruthy(entry)
      expect(entry.status).toBe('completed')
    }, 10000)

    it('should drop-then-rebuild a reclaimed index build so an invalid leftover is healed', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      // Stand in for the invalid index a crashed CONCURRENTLY build would leave: a same-named index
      // on a DIFFERENT column. A bare re-run of the command's `IF NOT EXISTS` would see the name and
      // skip, leaving the wrong index in place; healing must drop it and rebuild on the right column.
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)
      // Make it INVALID, as a crashed CREATE INDEX CONCURRENTLY leaves it, healing only drops an
      // invalid leftover, so a valid same-named index would (correctly) be left alone and not rebuilt.
      await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.heal_idx'::regclass`)

      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS heal_idx ON ${ctx.schema}.heal_test (b)`
      await insertBamRow(ctx.schema, 'heal_cmd', 'in_progress', command, 25 * 60 * 60)

      const done = waitForBamEvent(boss, 'heal_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = '${ctx.schema}' AND indexname = 'heal_idx'`
      )
      await db.close()

      // Rebuilt on (b): healing dropped the stale (a) index first.
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('(b)')
      expect(rows[0].indexdef).not.toContain('(a)')
    }, 10000)

    it('should heal a prior failed index build on retry (e.g. rows left by older releases)', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)
      // Invalid leftover, as a crashed/failed CONCURRENTLY build leaves it (see note above).
      await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.heal_idx'::regclass`)

      // A 'failed' row (as an older release, or a genuinely-failed CONCURRENTLY build, would leave)
      // must also heal on retry, otherwise the command's IF NOT EXISTS skips the stale index forever.
      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS heal_idx ON ${ctx.schema}.heal_test (b)`
      await insertBamRow(ctx.schema, 'failed_cmd', 'failed', command)

      const done = waitForBamEvent(boss, 'failed_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = '${ctx.schema}' AND indexname = 'heal_idx'`
      )
      await db.close()

      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('(b)')
      expect(rows[0].indexdef).not.toContain('(a)')
    }, 10000)

    // A first attempt's IF NOT EXISTS skips an INVALID index of the same name and returns without
    // building anything. The row fails instead of completing, and the retry heals the index. Postgres
    // only, since CockroachDB does not let a test mark an index INVALID.
    helper.itPostgresOnly('should fail a build that leaves an invalid index and heal it on retry', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      const errors: Error[] = []
      boss.on('error', err => errors.push(err))

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)
      await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.heal_idx'::regclass`)

      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS heal_idx ON ${ctx.schema}.heal_test (b)`
      await insertBamRow(ctx.schema, 'invalid_cmd', 'pending', command)

      const failed = waitForBamEvent(boss, 'invalid_cmd', 'failed')
      await triggerBamPoll(ctx.schema)
      await failed

      expect(errors.map(err => err.message)).toEqual(['index heal_idx is invalid after the build'])

      const done = waitForBamEvent(boss, 'invalid_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = '${ctx.schema}' AND indexname = 'heal_idx'`
      )
      await db.close()

      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('(b)')
    }, 10000)

    it('does NOT drop a VALID leftover index on reattempt (build succeeded but row was never marked)', async function () {
      // The dangerous case: a CREATE INDEX CONCURRENTLY that actually succeeded (VALID index, in use)
      // but whose bam row stayed in_progress because a graceful stop landed between the CREATE and
      // markCompleted. On reattempt, healing must NOT drop this live index. It should skip the drop,
      // let the command's IF NOT EXISTS no-op, and mark the row completed with the index intact.
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      // Valid index matching what the command builds, stands in for the already-succeeded build.
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)

      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS heal_idx ON ${ctx.schema}.heal_test (a)`
      await insertBamRow(ctx.schema, 'valid_cmd', 'in_progress', command, 25 * 60 * 60)

      const done = waitForBamEvent(boss, 'valid_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef, i.indisvalid AS valid
         FROM pg_indexes p JOIN pg_class c ON c.relname = p.indexname
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
         JOIN pg_index i ON i.indexrelid = c.oid
         WHERE p.schemaname = '${ctx.schema}' AND p.indexname = 'heal_idx'`
      )
      await db.close()

      // Index untouched: still valid, still on (a). It was never dropped.
      expect(rows).toHaveLength(1)
      expect(rows[0].valid).toBe(true)
      expect(rows[0].indexdef).toContain('(a)')
    }, 10000)

    it('completes a reattempt whose command has no IF NOT EXISTS when its index is already valid', async function () {
      // job_i7 and job_i8 were queued without IF NOT EXISTS. A short-lived process (one that starts,
      // schedules and stops within a second) can be stopped right after the CREATE: the index is
      // valid, the row is not marked, and every later attempt fails with "already exists".
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      const errors: Error[] = []
      boss.on('error', (err: Error) => errors.push(err))

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX strict_idx ON ${ctx.schema}.heal_test (a)`)

      const command = `CREATE INDEX CONCURRENTLY strict_idx ON ${ctx.schema}.heal_test (a)`
      await insertBamRow(ctx.schema, 'strict_cmd', 'in_progress', command, 25 * 60 * 60)

      const done = waitForBamEvent(boss, 'strict_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT status, error FROM ${ctx.schema}.bam WHERE name = 'strict_cmd'`
      )
      await db.close()

      expect(rows[0].status).toBe('completed')
      expect(rows[0].error).toBeNull()
      expect(errors).toHaveLength(0)
    }, 10000)

    it('recovers the shape already in the wild: a failed row carrying "already exists", and clears the error', async function () {
      // Every database that actually reported this is at status = 'failed' with the error text from at
      // least one "relation ... already exists" retry - not the in_progress shape above. Recovering it
      // must both complete the row and clear the stale message, since getBamEntries() returns error for
      // every status and operator tooling would otherwise keep showing a failure on a succeeded command.
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      const errors: Error[] = []
      boss.on('error', (err: Error) => errors.push(err))

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX strict_idx ON ${ctx.schema}.heal_test (a)`)

      const command = `CREATE INDEX CONCURRENTLY strict_idx ON ${ctx.schema}.heal_test (a)`
      const priorError = 'error: relation "strict_idx" already exists'
      await insertBamRow(ctx.schema, 'strict_failed_cmd', 'failed', command, undefined, priorError)

      const done = waitForBamEvent(boss, 'strict_failed_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT status, error FROM ${ctx.schema}.bam WHERE name = 'strict_failed_cmd'`
      )
      await db.close()

      expect(rows[0].status).toBe('completed')
      expect(rows[0].error).toBeNull()
      expect(errors).toHaveLength(0)
    }, 10000)

    it('should leave an INVALID leftover alone on a timeout-only backend and just re-run', async function () {
      // The drop is the only half that depends on liveness detection. CockroachDB/YugabyteDB roll an
      // interrupted build back, so there is nothing to heal there and DROP ... CONCURRENTLY is not
      // their model - the probe still runs, sees the INVALID index, and falls through to the command.
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        ...bamConfig,
        __test__noIndexProgressView: true
      })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)
      await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.heal_idx'::regclass`)

      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS heal_idx ON ${ctx.schema}.heal_test (b)`
      await insertBamRow(ctx.schema, 'invalid_timeout_cmd', 'failed', command)

      const done = waitForBamEvent(boss, 'invalid_timeout_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = '${ctx.schema}' AND indexname = 'heal_idx'`
      )
      await db.close()

      // Never dropped: the command's own IF NOT EXISTS saw the name and skipped, so the (a) index
      // is still there rather than rebuilt on (b).
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('(a)')
    }, 10000)

    it('should just run the command when a reattempt finds no index at all', async function () {
      // The third probe outcome: a prior attempt failed before the index existed, so there is nothing
      // to heal and nothing already built - the command simply runs.
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)

      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS absent_idx ON ${ctx.schema}.heal_test (a)`
      await insertBamRow(ctx.schema, 'absent_cmd', 'failed', command)

      const done = waitForBamEvent(boss, 'absent_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = '${ctx.schema}' AND indexname = 'absent_idx'`
      )
      await db.close()

      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('(a)')
    }, 10000)

    it('should recover the already-exists row on a timeout-only backend too', async function () {
      // CockroachDB/YugabyteDB take the timeout-only claim, where a stuck row is reclaimable only
      // after BAM_STALE_SECONDS (24 hours), so they need this recovery more than native Postgres,
      // not less. Only the DROP half depends on liveness detection; the probe is a plain pg_index
      // read, so it runs here as well and short-circuits the un-rerunnable command.
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        ...bamConfig,
        __test__noIndexProgressView: true
      })
      const errors: Error[] = []
      boss.on('error', (err: Error) => errors.push(err))

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX strict_idx ON ${ctx.schema}.heal_test (a)`)

      const command = `CREATE INDEX CONCURRENTLY strict_idx ON ${ctx.schema}.heal_test (a)`
      await insertBamRow(ctx.schema, 'strict_timeout_cmd', 'failed', command, undefined, 'error: relation "strict_idx" already exists')

      const done = waitForBamEvent(boss, 'strict_timeout_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT status, error FROM ${ctx.schema}.bam WHERE name = 'strict_timeout_cmd'`
      )
      await db.close()

      expect(rows[0].status).toBe('completed')
      expect(rows[0].error).toBeNull()
      expect(errors).toHaveLength(0)
    }, 10000)

    it('should not heal on backends without pg_stat_progress_create_index (timeout-only reclaim)', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, __test__noIndexProgressView: true })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)

      // Same reclaim, but no liveness backend → no drop-then-rebuild. The probe still runs (it only
      // reads pg_index), finds a VALID index and short-circuits, so the pre-existing (a) index
      // survives untouched. The (b) rebuild the liveness path would do never happens.
      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS heal_idx ON ${ctx.schema}.heal_test (b)`
      await insertBamRow(ctx.schema, 'heal_cmd', 'in_progress', command, 25 * 60 * 60)

      const done = waitForBamEvent(boss, 'heal_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = '${ctx.schema}' AND indexname = 'heal_idx'`
      )
      await db.close()

      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('(a)')
    }, 10000)

    it('should not reclaim a fresh in_progress command (guards against double-run)', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      // A genuinely running command (started seconds ago) must still block the queue so two
      // instances never execute the same command concurrently.
      await insertBamRow(ctx.schema, 'fresh_cmd', 'in_progress', 'SELECT 1', 5)
      await insertBamRow(ctx.schema, 'pending_cmd', 'pending', 'SELECT 1')

      await triggerBamPoll(ctx.schema)
      await delay(1500)

      const entries = await boss.getBamEntries()
      const fresh = entries.find((e: any) => e.name === 'fresh_cmd')
      const pending = entries.find((e: any) => e.name === 'pending_cmd')

      helper.assertTruthy(fresh)
      helper.assertTruthy(pending)
      expect(fresh.status).toBe('in_progress')
      expect(pending.status).toBe('pending')
    }, 10000)
  })

  // The liveness signal for reclaiming a stale in_progress build is pg_locks (cluster-wide, visible
  // across DB roles), not pg_stat_progress_create_index (filtered to the caller's own backends). This
  // is what lets pg-boss instances run under different roles without a peer's in-flight build reading
  // as "dead" and getting its live index dropped by the heal step. A held ShareUpdateExclusiveLock,
  // the exact lock CREATE INDEX CONCURRENTLY holds for the whole build, must therefore block reclaim.
  helper.describeMultiConnectionOnly('pg_locks liveness (cross-role safe)', function () {
    it('should not reclaim a stale build while a ShareUpdateExclusiveLock is held on its table, then reclaim once released', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.live_tbl (a int)`)
      await db.close()

      // A separate backend stands in for an in-flight CREATE INDEX CONCURRENTLY by holding the very lock
      // one takes (ShareUpdateExclusiveLock) on the build's table for the whole window.
      const holder = new pg.Client({ connectionString: helper.getConnectionString() })
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query(`LOCK TABLE ${ctx.schema}.live_tbl IN SHARE UPDATE EXCLUSIVE MODE`)

      try {
        // Stale by the liveness grace window (backdated well past BAM_LIVENESS_GRACE_SECONDS), but its
        // table shows a live build in pg_locks, so liveBuild=true → the row must NOT be reclaimed.
        await insertBamRowOnTable(ctx.schema, 'locked_cmd', 'in_progress', 'SELECT 1', 'live_tbl', 10 * 60)

        await triggerBamPoll(ctx.schema)
        await delay(1500)

        let entry = (await boss.getBamEntries()).find((e: any) => e.name === 'locked_cmd')
        helper.assertTruthy(entry)
        expect(entry.status).toBe('in_progress') // held lock reads as a live build → reclaim blocked

        // Release the lock: the "build" is gone, so the same stale row becomes reclaimable and runs.
        await holder.query('ROLLBACK')

        const done = waitForBamEvent(boss, 'locked_cmd', 'completed')
        await triggerBamPoll(ctx.schema)
        await done

        entry = (await boss.getBamEntries()).find((e: any) => e.name === 'locked_cmd')
        helper.assertTruthy(entry)
        expect(entry.status).toBe('completed')
      } finally {
        await holder.end()
      }
    }, 15000)
  })

  // The mirror case: a stop that lands between the claim UPDATE returning and the runner picking the
  // command up. Nothing has run, so the claim must be handed back rather than left in_progress - an
  // in_progress row blocks every other BAM command until it goes stale.
  describe('stop between the claim and the run', function () {
    it('should report a release that fails instead of throwing into the poll', async function () {
      // The release runs on the way out of a stop. If it fails the row keeps the claim and recovers on
      // the stale path, so the failure is reported rather than thrown - throwing would surface as a
      // bare poll error with no indication that a claim was stranded.
      const _db = await helper.getDb()
      const failingDb = Object.create(_db)
      failingDb.executeSql = async (text: string, values?: unknown[]) => {
        if (/SET status = 'pending'/i.test(text)) {
          throw new Error('connection terminated while releasing the claim')
        }
        return _db.executeSql(text, values)
      }

      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        ...bamConfig,
        db: failingDb,
        __test__delay_bam_claim_ms: 2000
      })
      const errors: Error[] = []
      boss.on('error', (err: Error) => errors.push(err))

      await insertBamRow(ctx.schema, 'unreleasable_cmd', 'pending', 'SELECT 1')

      await triggerBamPoll(ctx.schema)
      await waitForBamStatus(ctx.schema, 'unreleasable_cmd', 'in_progress')

      // stop() closes the pool this db wraps, so read the row back on a fresh connection.
      await boss.stop()

      const check = await helper.getDb()
      const { rows } = await check.executeSql(
        `SELECT status FROM ${ctx.schema}.bam WHERE name = 'unreleasable_cmd'`
      )
      await check.close()

      expect(errors.some(e => /while releasing the claim/i.test(e.message))).toBe(true)
      // The claim is stranded, exactly as the comment says - the stale path reclaims it.
      expect(rows[0].status).toBe('in_progress')
    }, 20000)

    it('should hand a pending row back as pending, with started_on cleared', async function () {
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        ...bamConfig,
        // Holds the runner between the claim and its stopped check, which is otherwise a
        // single-round-trip window no test could land in.
        __test__delay_bam_claim_ms: 2000
      })
      boss.on('error', () => {})

      await insertBamRow(ctx.schema, 'release_cmd', 'pending', 'SELECT 1')

      await triggerBamPoll(ctx.schema)
      await waitForBamStatus(ctx.schema, 'release_cmd', 'in_progress')

      await boss.stop()

      const db = await helper.getDb()
      const { rows } = await db.executeSql(
        `SELECT status, started_on as "startedOn", completed_on as "completedOn" FROM ${ctx.schema}.bam WHERE name = 'release_cmd'`
      )
      await db.close()

      // Back to exactly what the claim found: reclaimable on the next poll, not blocking the queue.
      expect(rows[0].status).toBe('pending')
      expect(rows[0].startedOn).toBeNull()
      expect(rows[0].completedOn).toBeNull()
    }, 20000)

    it('should restore a stale reclaim to in_progress with its original started_on', async function () {
      // The load-bearing half: a released stale in_progress row must keep the OLD started_on. Stamping
      // it with now() would restart the stale clock - a fresh grace window on native Postgres, a fresh
      // 24 hours on the timeout-only backends - on a command that never ran.
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        ...bamConfig,
        __test__delay_bam_claim_ms: 2000
      })
      boss.on('error', () => {})

      // Baseline from the insert itself. Reading it back in a second statement races the startup
      // poll, which can claim the stale row in between and leave the baseline already equal to the
      // claimed value, so nothing ever "moves" and the wait below times out.
      const priorStartedOn = await insertBamRow(ctx.schema, 'release_stale_cmd', 'in_progress', 'SELECT 1', 25 * 60 * 60)

      const db = await helper.getDb()

      await triggerBamPoll(ctx.schema)
      // Claimed means started_on moved to now(); wait for that rather than for the status, which was
      // already in_progress.
      await waitForBamClaim(ctx.schema, 'release_stale_cmd', priorStartedOn)

      await boss.stop()

      const after = await db.executeSql(
        `SELECT status, started_on as "startedOn" FROM ${ctx.schema}.bam WHERE name = 'release_stale_cmd'`
      )
      await db.close()

      expect(after.rows[0].status).toBe('in_progress')
      expect(new Date(after.rows[0].startedOn).getTime()).toBe(new Date(priorStartedOn).getTime())
    }, 20000)
  })

  describe('a write that records the outcome fails', function () {
    it('should still report which command failed when marking it failed also fails', async function () {
      // The UPDATE that records a failure commonly runs on the connection that just failed: a
      // terminated backend or a dropped connection fails the command AND the write that would record
      // it. If that write is allowed to throw, the real failure is replaced by the write's error and
      // the operator never learns which command failed.
      const _db = await helper.getDb()
      // Delegate rather than spread: the db is a class instance (and an event emitter), so a shallow
      // copy would drop everything on its prototype.
      const failingDb = Object.create(_db)
      failingDb.executeSql = async (text: string, values?: unknown[]) => {
        if (/SET status = 'failed'/i.test(text)) {
          throw new Error('connection terminated while recording the failure')
        }
        return _db.executeSql(text, values)
      }

      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, db: failingDb })
      const errors: Error[] = []
      boss.on('error', (err: Error) => errors.push(err))

      await insertBamCommand(ctx.schema, 'unrecordable_cmd', 'SELECT 1/0')

      const failed = waitForBamEvent(boss, 'unrecordable_cmd', 'failed')
      await triggerBamPoll(ctx.schema)
      await failed
      await _db.close()

      // Both surface: the command's own failure, and the write that could not record it.
      expect(errors.some(e => /division by zero/i.test(e.message))).toBe(true)
      expect(errors.some(e => /connection terminated while recording/i.test(e.message))).toBe(true)
    }, 10000)
  })

  // The BAM queue runs one command at a time, in enqueue order: until the command a worker claimed is
  // done, no other worker may pull ANY entry - not the same one, and not the next one. That is what
  // keeps async migrations sequential across instances.
  helper.describeMultiConnectionOnly('one command at a time', function () {
    it('should let only one of two concurrent claims win, and hold the next command until it finishes', async function () {
      // Only here to build the schema. Its bam poller competes for the rows below: the startup poll
      // is fire-and-forget (setImmediate in Bam.start), so on a loaded box it lands after these
      // inserts and claims a row out from under the claims this test makes by hand. Shut the
      // instance down and keep the schema.
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, bamIntervalSeconds: 60 })
      await ctx.boss.stop()

      const db = await helper.getDb()
      await db.executeSql(`
        INSERT INTO ${ctx.schema}.bam (name, version, status, table_name, command, created_on)
        VALUES ('first', 27, 'pending', 'job_common', 'SELECT 1', now() - interval '2 minutes'),
               ('second', 27, 'pending', 'job_common', 'SELECT 2', now() - interval '1 minute')
      `)

      const claim = plans.getNextBamCommand(ctx.schema, { useLiveness: false })

      // A holds its claim open; B races it on a snapshot that predates A's commit. Without the
      // compare-and-swap in the UPDATE's own WHERE clause, READ COMMITTED re-checks only
      // `b.id = candidate.id` - which is still true - so B claims the same row A just took.
      const peer = new pg.Client({ connectionString: helper.getConnectionString() })
      await peer.connect()

      let winner: any
      try {
        await db.executeSql('BEGIN')
        const a = await db.executeSql(claim)
        const raced = peer.query(claim)
        await delay(300)
        await db.executeSql('COMMIT')
        const b = await raced

        expect(a.rows).toHaveLength(1)
        expect(a.rows[0].name).toBe('first')
        expect(b.rows).toHaveLength(0)
        winner = a.rows[0]

        // Still in flight: nobody may pull the NEXT command either.
        const held = await peer.query(claim)
        expect(held.rows).toHaveLength(0)

        // Only once it completes does the queue move on, and to the next command in order.
        await db.executeSql(plans.setBamCompleted(ctx.schema, winner.id))
        const next = await peer.query(claim)
        expect(next.rows).toHaveLength(1)
        expect(next.rows[0].name).toBe('second')
      } finally {
        await peer.end()
        await db.close()
      }
    }, 15000)
  })

  // Commands from one migration on one table are an ordered sequence: v40 builds job_i11 and then
  // drops job_i5, and the drop must not run after the build failed.
  describe('ordering within a migration', function () {
    it('should hold a command behind an earlier one of the same migration and table until it completes', async function () {
      // Only here to build the schema; its own runner would race the claims made by hand.
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, bamIntervalSeconds: 60 })
      await ctx.boss.stop()

      const db = await helper.getDb()

      try {
        for (const useLiveness of helper.isCockroachDb ? [false] : [false, true]) {
          await db.executeSql(`DELETE FROM ${ctx.schema}.bam`)
          await db.executeSql(`
            INSERT INTO ${ctx.schema}.bam (name, version, status, table_name, command, created_on)
            VALUES ('build', 40, 'failed', 'job_common', 'SELECT 1', now() - interval '4 minutes'),
                   ('retire', 40, 'pending', 'job_common', 'SELECT 2', now() - interval '3 minutes'),
                   ('other_table', 40, 'pending', 'job_other', 'SELECT 3', now() - interval '2 minutes'),
                   ('other_version', 41, 'pending', 'job_common', 'SELECT 4', now() - interval '1 minute')
          `)

          const claim = async (pendingOnly: boolean) => {
            const { rows } = await db.executeSql(plans.getNextBamCommand(ctx.schema, { useLiveness, pendingOnly }))
            if (rows[0]) await db.executeSql(plans.setBamCompleted(ctx.schema, rows[0].id))
            return rows[0]?.name ?? null
          }

          // The rest of a burst skips the retire, held behind its failed build, and takes what else is pending.
          expect(await claim(true)).toBe('other_table')
          expect(await claim(true)).toBe('other_version')
          expect(await claim(true)).toBeNull()

          // The next poll retries the build, and only then is the retire claimable.
          expect(await claim(false)).toBe('build')
          expect(await claim(true)).toBe('retire')
        }
      } finally {
        await db.close()
      }
    }, 15000)
  })

  describe('heal recognition', function () {
    it('should return a probe exactly when it returns a drop', function () {
      // bam.ts runs the probe first and then drops without re-checking, so the two must recognise the
      // same commands. If they ever diverge the drop would be null where the probe was not.
      const indexCommand = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON s.t (a)'
      expect(plans.bamHealProbe('s', indexCommand)).toBeTruthy()
      expect(plans.bamHealDrop('s', indexCommand)).toBeTruthy()

      // A command that builds no index has nothing to probe and nothing to drop.
      expect(plans.bamHealProbe('s', 'SELECT 1')).toBeNull()
      expect(plans.bamHealDrop('s', 'SELECT 1')).toBeNull()
      expect(plans.bamHealProbe('s', 'CREATE INDEX i ON s.t (a)')).toBeNull()
      expect(plans.bamHealDrop('s', 'CREATE INDEX i ON s.t (a)')).toBeNull()
    })
  })

  // Once a poll claims a command, the runner keeps claiming until no pending row is left, rather than
  // waiting bamIntervalSeconds between commands. The interval here is 60 seconds, so a second poll
  // cannot land inside the test: every row completing proves they ran in one burst.
  describe('burst', function () {
    async function startRunner () {
      // Only here to build the schema; its own runner would race the one under test.
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, bamIntervalSeconds: 60 })
      await ctx.boss.stop()

      const db = await helper.getDb()
      const bam = new Bam(db, {
        schema: ctx.schema,
        bamIntervalSeconds: 60,
        migrate: true,
        clock: systemClock,
        noIndexProgressView: helper.isCockroachDb
      } as any)

      const events: any[] = []
      bam.on('bam', event => events.push(event))
      bam.on('error', () => {})

      return { db, bam, events }
    }

    it('should run every pending command from one poll', async function () {
      const { db, bam } = await startRunner()

      try {
        await db.executeSql(`
          INSERT INTO ${ctx.schema}.bam (name, version, status, table_name, command, created_on)
          VALUES ('burst_1', 27, 'pending', 'job_common', 'SELECT 1', now() - interval '3 minutes'),
                 ('burst_2', 27, 'pending', 'job_common', 'SELECT 2', now() - interval '2 minutes'),
                 ('burst_3', 27, 'pending', 'job_common', 'SELECT 3', now() - interval '1 minute')
        `)
        await db.executeSql(`UPDATE ${ctx.schema}.version SET bam_on = NULL`)

        await bam.start()
        await waitForBamStatus(ctx.schema, 'burst_3', 'completed')

        const { rows } = await db.executeSql(
          `SELECT name, status FROM ${ctx.schema}.bam WHERE name LIKE 'burst_%' ORDER BY completed_on`
        )
        expect(rows).toEqual([
          { name: 'burst_1', status: 'completed' },
          { name: 'burst_2', status: 'completed' },
          { name: 'burst_3', status: 'completed' }
        ])
      } finally {
        await bam.stop()
        await db.close()
      }
    }, 15000)

    it('should not retry a command that failed earlier in the same burst', async function () {
      const { db, bam, events } = await startRunner()

      try {
        await db.executeSql(`
          INSERT INTO ${ctx.schema}.bam (name, version, status, table_name, command, created_on)
          VALUES ('burst_fail', 27, 'pending', 'job_common', 'SELECT 1/0', now() - interval '2 minutes'),
                 ('burst_after', 27, 'pending', 'job_other', 'SELECT 1', now() - interval '1 minute')
        `)
        await db.executeSql(`UPDATE ${ctx.schema}.version SET bam_on = NULL`)

        await bam.start()
        await waitForBamStatus(ctx.schema, 'burst_after', 'completed')
        // Long enough for a looping burst to have claimed the failed row again.
        await delay(500)

        const attempts = events.filter(e => e.name === 'burst_fail' && e.status === 'in_progress')
        expect(attempts).toHaveLength(1)

        const { rows } = await db.executeSql(`SELECT status FROM ${ctx.schema}.bam WHERE name = 'burst_fail'`)
        expect(rows[0].status).toBe('failed')
      } finally {
        await bam.stop()
        await db.close()
      }
    }, 15000)
  })

  describe('start and stop', function () {
    it('should ignore a second start', async function () {
      const db = await helper.getDb()
      const bam = new Bam(db, {
        schema: ctx.schema,
        bamIntervalSeconds: 60,
        migrate: true,
        clock: systemClock
      } as any)
      bam.on('error', () => {})

      try {
        await bam.start()
        // A second start must not replace the running poll timer - the first one would then never be
        // cleared and would keep firing after stop().
        await bam.start()
        await bam.stop()
        // Idempotent in the other direction too.
        await bam.stop()
      } finally {
        await db.close()
      }
    }, 10000)
  })

  describe('releasing a claim', function () {
    it('should not release a claim a peer has since taken', async function () {
      // The timeout-only claim has no SKIP LOCKED, so two overlapping claims can both return the same
      // row - verified directly against the claim SQL, both get rowCount 1 with the same prior_status.
      // Releasing on the id alone would then reset a row a peer is actively building back to 'pending'
      // and the next poll would start a second CREATE INDEX CONCURRENTLY on the same index. The peer's
      // claim is stood in for here by rewriting started_on, which is exactly what its claim would do.
      // Only here to build the schema. Its bam poller competes for the rows below: the startup poll
      // is fire-and-forget (setImmediate in Bam.start), so on a loaded box it lands after these
      // inserts and claims a row out from under the claims this test makes by hand. Shut the
      // instance down and keep the schema.
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, bamIntervalSeconds: 60 })
      await ctx.boss.stop()

      const db = await helper.getDb()
      await insertBamRow(ctx.schema, 'contended_cmd', 'pending', 'SELECT 1')

      const claim = await db.executeSql(plans.getNextBamCommand(ctx.schema, { useLiveness: false }))
      const entry = claim.rows[0]
      expect(entry.name).toBe('contended_cmd')

      const peerClaimedOn = '2026-01-02T03:04:05.123456+00:00'
      await db.executeSql(
        `UPDATE ${ctx.schema}.bam SET started_on = '${peerClaimedOn}'::timestamptz WHERE id = '${entry.id}'`
      )

      const release = await db.executeSql(plans.releaseBamCommand(
        ctx.schema, entry.id, entry.priorStatus, entry.priorStartedOn, entry.claimedStartedOn
      ))
      expect(release.rows).toHaveLength(0)

      const { rows } = await db.executeSql(
        `SELECT status, started_on as "startedOn" FROM ${ctx.schema}.bam WHERE id = '${entry.id}'`
      )
      await db.close()

      // Untouched: still the peer's claim, not handed back to 'pending'.
      expect(rows[0].status).toBe('in_progress')
      expect(new Date(rows[0].startedOn).getTime()).toBe(new Date(peerClaimedOn).getTime())
    }, 10000)
  })

  // A stop that lands while a command is running must not throw the result away. stop() waits out the
  // in-flight command up to its timeout, and the pool is closed only after bam.stop() resolves, so the
  // row can - and must - be marked. An unmarked row behind a VALID index is the orphan every "already exists" retry loop
  // starts from, and on the timeout-only backends it blocks the whole BAM queue for 24 hours.
  helper.describeMultiConnectionOnly('stop during an in-flight command', function () {
    it('should mark a command completed when a stop lands after it succeeds', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.stop_test (a int)`)

      // Hold a snapshot on the table so CREATE INDEX CONCURRENTLY parks in its wait phase. That keeps
      // the command in flight for as long as we need to call stop() on top of it.
      const holder = new pg.Client({ connectionString: helper.getConnectionString() })
      await holder.connect()
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query(`SELECT * FROM ${ctx.schema}.stop_test`)

      let stopping: Promise<void> | undefined

      try {
        const command = `CREATE INDEX CONCURRENTLY stop_idx ON ${ctx.schema}.stop_test (a)`
        await insertBamRow(ctx.schema, 'stop_cmd', 'pending', command)

        const started = waitForBamEvent(boss, 'stop_cmd', 'in_progress')
        await triggerBamPoll(ctx.schema)
        await started

        // Let the build reach its wait phase, then stop while it is still blocked.
        await delay(500)
        stopping = boss.stop()
        await delay(500)
      } finally {
        // Releasing the snapshot lets the build finish - after the stop has already been requested.
        await holder.query('ROLLBACK')
        await holder.end()
      }

      await stopping

      const { rows } = await db.executeSql(
        `SELECT status, error FROM ${ctx.schema}.bam WHERE name = 'stop_cmd'`
      )
      const index = await db.executeSql(
        `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = '${ctx.schema}.stop_idx'::regclass`
      )
      await db.close()

      // The index was built and the row says so: no orphan for a later attempt to trip over.
      expect(index.rows[0].valid).toBe(true)
      expect(rows[0].status).toBe('completed')
      expect(rows[0].error).toBeNull()
    }, 20000)
  })

  // The timeout bounds a command still running at the stop() deadline. A concurrent index statement on
  // Postgres is left running on the server with its row in_progress. Anything else is cancelled and
  // rolls back, and its row is marked failed without an error event and runs again.
  helper.describePglite('stop deadline', function () {
    async function startCommand (name: string, command: string, options = {}) {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, ...options })
      const errors: Error[] = []
      boss.on('error', err => errors.push(err))

      await insertBamRow(ctx.schema, name, 'pending', command)

      const started = waitForBamEvent(boss, name, 'in_progress')
      await triggerBamPoll(ctx.schema)
      await started
      await delay(500)

      return { boss, errors }
    }

    async function readRow (name: string) {
      const db = await helper.getDb()
      const { rows } = await db.executeSql(`SELECT status, error FROM ${ctx.schema}.bam WHERE name = $1`, [name])
      await db.close()
      return rows[0]
    }

    async function holdOpen (sql: string) {
      const holder = new pg.Client({ connectionString: helper.getConnectionString() })
      await holder.connect()
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query(sql)
      return holder
    }

    it('should cancel a command still running when the timeout passes', async function () {
      const { boss, errors } = await startCommand('sleep_cmd', 'SELECT pg_sleep(60)')

      const begun = Date.now()
      await boss.stop({ timeout: 1000 })

      expect(Date.now() - begun).toBeLessThan(10000)
      expect((await readRow('sleep_cmd')).status).toBe('failed')
      expect(errors).toEqual([])
    }, 30000)

    // A TestClock wraps the db to count statements in flight, and the wrapper has to pass the stop
    // signals on, or stop() waits for a build it would leave running.
    helper.itPostgresOnly('should leave an index build running at the timeout under a TestClock', async function () {
      const db = await helper.getDb()
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      await db.executeSql(`CREATE TABLE ${ctx.schema}.abandon_test (a int)`)
      await ctx.boss.stop()
      await db.close()

      // A snapshot on the table parks CREATE INDEX CONCURRENTLY in its wait phase.
      const holder = await holdOpen(`SELECT * FROM ${ctx.schema}.abandon_test`)

      try {
        const clock = new TestClock()
        const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, clock })
        const errors: Error[] = []
        boss.on('error', err => errors.push(err))

        const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS abandon_idx ON ${ctx.schema}.abandon_test (a)`
        await insertBamRow(ctx.schema, 'abandon_cmd', 'pending', command)
        await triggerBamPoll(ctx.schema)

        // Not awaited: the tick waits for statements in flight, the build among them.
        const started = waitForBamEvent(boss, 'abandon_cmd', 'in_progress')
        const ticked = clock.tick(1000)
        await started
        await delay(500)

        const begun = Date.now()
        await boss.stop({ timeout: 1000 })

        expect(Date.now() - begun).toBeLessThan(5000)
        expect((await readRow('abandon_cmd')).status).toBe('in_progress')
        expect(errors).toEqual([])
        await ticked
      } finally {
        await holder.query('ROLLBACK')
        await holder.end()
      }
    }, 30000)

    it('should cancel a running command at once without graceful', async function () {
      const { boss, errors } = await startCommand('sleep_cmd', 'SELECT pg_sleep(60)')

      const begun = Date.now()
      await boss.stop({ graceful: false, timeout: 20000 })

      expect(Date.now() - begun).toBeLessThan(10000)
      expect((await readRow('sleep_cmd')).status).toBe('failed')
      expect(errors).toEqual([])
    }, 30000)

    // pg_cancel_backend reaches whatever statement the backend runs when the signal lands. A command
    // that ends just before then goes back to the pool and the signal hits the next query on that
    // connection, so stop() closes it instead. Catching the cancel stands in for a command that ends
    // without it: the command succeeds and its connection still has to close.
    helper.itPostgresOnly('should close the connection of a command it set out to cancel instead of returning it to the pool', async function () {
      const command = 'DO $$ BEGIN PERFORM pg_sleep(60); EXCEPTION WHEN query_canceled THEN NULL; END $$'
      const { boss, errors } = await startCommand('caught_cmd', command)

      const db = await helper.getDb()
      const { rows } = await db.executeSql("SELECT pid FROM pg_stat_activity WHERE query LIKE '/* pgboss bam %' AND state = 'active'")
      expect(rows).toHaveLength(1)

      await boss.stop({ timeout: 1000, close: false })

      expect((await readRow('caught_cmd')).status).toBe('completed')
      expect(errors).toEqual([])

      let alive = true
      for (let i = 0; i < 50 && alive; i++) {
        const { rows: found } = await db.executeSql('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [rows[0].pid])
        alive = found.length > 0
        if (alive) await delay(100)
      }
      await db.close()

      expect(alive).toBe(false)
    }, 30000)

    // CockroachDB through pg-boss's own pool drops the connection rather than cancelling. Started with
    // the CockroachDB backend on Postgres, as distributedDatabaseTest does, so the path runs here too.
    it('should drop the connection of a running command on CockroachDB', async function () {
      const { boss, errors } = await startCommand('drop_cmd', 'SELECT pg_sleep(3)', { backend: 'cockroachdb' })

      const begun = Date.now()
      await boss.stop({ timeout: 1000 })

      expect(Date.now() - begun).toBeLessThan(2500)
      expect((await readRow('drop_cmd')).status).toBe('failed')
      expect(errors).toEqual([])
    }, 30000)

    // A deadline that passes between a row's statements, here while a re-attempt reads the catalog,
    // finds nothing to cancel. The command never starts, and the row is marked failed.
    it('should not start a command once the timeout has passed', async function () {
      const pool = await helper.getDb()

      try {
        const db = {
          executeSql: async (text: string, values?: unknown[]) => {
            if (text.includes('NOT i.indisvalid AS invalid')) await delay(2500)
            return await pool.executeSql(text, values)
          }
        }

        const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, db })
        const errors: Error[] = []
        boss.on('error', err => errors.push(err))

        await pool.executeSql(`CREATE TABLE ${ctx.schema}.late_test (a int)`)
        const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS late_idx ON ${ctx.schema}.late_test (a)`
        await insertBamRow(ctx.schema, 'late_cmd', 'failed', command)

        const started = waitForBamEvent(boss, 'late_cmd', 'in_progress')
        await triggerBamPoll(ctx.schema)
        await started

        await boss.stop({ timeout: 1000 })

        const row = await readRow('late_cmd')
        expect(row.status).toBe('failed')
        expect(row.error).toContain('stop() ended the command before it ran')
        expect(errors).toEqual([])

        const { rows } = await pool.executeSql(`SELECT to_regclass('${ctx.schema}.late_idx') AS idx`)
        expect(rows[0].idx).toBeNull()
      } finally {
        await pool.close()
      }
    }, 30000)

    // Either signal can abort while the statement waits for a pooled connection. The connection it
    // gets then goes back to the pool without running anything.
    for (const option of ['signal', 'retire'] as const) {
      it(`should return a connection that arrives after its ${option} aborted`, async function () {
        const db = new Db({ ...helper.getConfig(), max: 1 })
        await db.open()

        try {
          const busy = db.executeSql('SELECT pg_sleep(0.5)')

          const abort = new AbortController()
          const waiting = db.executeSql('SELECT 1', undefined, { [option]: abort.signal })
          abort.abort()

          await expect(waiting).rejects.toThrow('This operation was aborted')
          await busy

          expect(db.poolCounts()).toMatchObject({ total: 1, idle: 1 })
        } finally {
          await db.close()
        }
      }, 30000)
    }

    // A statement that fails inside an explicit transaction leaves its connection in an aborted
    // transaction. Closed instead of pooled, it cannot fail the next query.
    helper.itPostgresOnly('should close the connection of a statement that failed', async function () {
      const db = new Db({ ...helper.getConfig(), max: 1 })
      await db.open()

      try {
        const retire = new AbortController().signal
        await expect(db.executeSql('BEGIN; SELECT 1/0', undefined, { retire })).rejects.toThrow('division by zero')

        const { rows } = await db.executeSql('SELECT 1 AS one')
        expect(rows[0].one).toBe(1)
      } finally {
        await db.close()
      }
    }, 30000)

    // A connection lost mid-statement without a message from the server (a failover, a proxy
    // restart) emits 'error' on the client. The statement rejects instead of the process crashing.
    helper.itPostgresOnly('should reject a statement whose connection is lost', async function () {
      const db = new Db({ ...helper.getConfig(), max: 1 })
      await db.open()

      try {
        const pool = (db as unknown as { pool: pg.Pool }).pool
        let client: any
        pool.once('acquire', acquired => { client = acquired })

        const retire = new AbortController().signal
        const running = db.executeSql('SELECT pg_sleep(5)', undefined, { retire })

        await delay(300)
        client.connection.stream.destroy()

        await expect(running).rejects.toThrow('Connection terminated unexpectedly')

        const { rows } = await db.executeSql('SELECT 1 AS one')
        expect(rows[0].one).toBe(1)
      } finally {
        await db.close()
      }
    }, 30000)

    // A Db whose statements from #execute wait before they ask for a connection, so stop() aborts
    // them first.
    class SlowStartDb extends Db {
      async executeSql (text: string, values?: unknown[], options?: { signal?: AbortSignal, retire?: AbortSignal }) {
        if (options?.signal || options?.retire) await delay(2500)
        return await super.executeSql(text, values, options)
      }
    }

    // An abandoned statement leaves its row in_progress for the liveness check, but one that never
    // started has nothing for the check to find, so its row is marked failed.
    for (const [name, command] of [
      ['abandon', (schema: string) => `CREATE INDEX CONCURRENTLY IF NOT EXISTS slow_idx ON ${schema}.slow_test (a)`],
      ['cancel', () => 'SELECT 1']
    ] as const) {
      helper.itPostgresOnly(`should mark a row failed when stop() aborts its ${name} statement before it starts`, async function () {
        const db = new SlowStartDb(helper.getConfig())
        await db.open()

        try {
          const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, db })
          const errors: Error[] = []
          boss.on('error', err => errors.push(err))

          await db.executeSql(`CREATE TABLE ${ctx.schema}.slow_test (a int)`)

          await insertBamRow(ctx.schema, 'slow_cmd', 'pending', command(ctx.schema))

          const started = waitForBamEvent(boss, 'slow_cmd', 'in_progress')
          await triggerBamPoll(ctx.schema)
          await started

          await boss.stop({ timeout: 1000, close: false })

          const row = await readRow('slow_cmd')
          expect(row.status).toBe('failed')
          expect(row.error).toContain('stop() ended the command before it ran')
          expect(errors).toEqual([])
        } finally {
          await db.close()
        }
      }, 30000)
    }

    // stop() aborts before it sends the cancel, so a statement still waiting for a connection gives up
    // while the cancel is in flight and finds nothing. The cancel must not undo what the statement
    // recorded, or the row's failure would be reported as an error.
    helper.itPostgresOnly('should not emit an error for a statement that gave up while the cancel was in flight', async function () {
      class SlowCancelDb extends Db {
        async executeSql (text: string, values?: unknown[], options?: { signal?: AbortSignal, retire?: AbortSignal }) {
          if (options?.signal || options?.retire) await delay(2500)
          if (text.includes('pg_cancel_backend')) await delay(2000)
          if (text.includes("SET status = 'failed'")) await delay(1000)
          return await super.executeSql(text, values, options)
        }
      }

      const db = new SlowCancelDb(helper.getConfig())
      await db.open()

      try {
        const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, db })
        const errors: Error[] = []
        boss.on('error', err => errors.push(err))

        await insertBamRow(ctx.schema, 'cancel_cmd', 'pending', 'SELECT 1')

        const started = waitForBamEvent(boss, 'cancel_cmd', 'in_progress')
        await triggerBamPoll(ctx.schema)
        await started

        await boss.stop({ timeout: 1000, close: false })

        const row = await readRow('cancel_cmd')
        expect(row.status).toBe('failed')
        expect(row.error).toContain('stop() ended the command before it ran')
        expect(errors).toEqual([])
      } finally {
        await db.close()
      }
    }, 30000)

    // A stop that lands after the build returns, here while the build's index is read back, has no
    // statement to end. The read's failure is the command's, so the row is marked failed with an error.
    helper.itPostgresOnly('should mark a row failed when stop() lands while the build is checked', async function () {
      class SlowProbeDb extends Db {
        async executeSql (text: string, values?: unknown[], options?: { signal?: AbortSignal, retire?: AbortSignal }) {
          if (text.includes('NOT i.indisvalid AS invalid')) await delay(2500)
          return await super.executeSql(text, values, options)
        }
      }

      const db = new SlowProbeDb(helper.getConfig())
      await db.open()

      try {
        const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, db })
        const errors: Error[] = []
        boss.on('error', err => errors.push(err))

        await db.executeSql(`CREATE TABLE ${ctx.schema}.probe_test (a int, b int)`)
        await db.executeSql(`CREATE INDEX probe_idx ON ${ctx.schema}.probe_test (a)`)
        await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.probe_idx'::regclass`)

        await insertBamRow(ctx.schema, 'probe_cmd', 'pending', `CREATE INDEX CONCURRENTLY IF NOT EXISTS probe_idx ON ${ctx.schema}.probe_test (b)`)

        const started = waitForBamEvent(boss, 'probe_cmd', 'in_progress')
        await triggerBamPoll(ctx.schema)
        await started

        await boss.stop({ timeout: 1000, close: false })

        expect((await readRow('probe_cmd')).status).toBe('failed')
        expect(errors.map(err => err.message)).toEqual(['index probe_idx is invalid after the build'])
      } finally {
        await db.close()
      }
    }, 30000)

    // On CockroachDB a build stop() dropped goes on as a schema change job, and a retry finds no index
    // until it ends. The retry fails its row without an error event. Run on Postgres with the
    // CockroachDB backend and a catalog read that finds nothing.
    it('should fail a CockroachDB build whose index is still being added without an error event', async function () {
      const pool = await helper.getDb()

      try {
        const db = {
          executeSql: async (text: string, values?: unknown[]) => text.includes('NOT i.indisvalid AS invalid')
            ? { rows: [] }
            : await pool.executeSql(text, values)
        }

        const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, db, backend: 'cockroachdb' })
        const errors: Error[] = []
        boss.on('error', err => errors.push(err))

        await pool.executeSql(`CREATE TABLE ${ctx.schema}.pending_test (a int)`)

        await insertBamRow(ctx.schema, 'pending_cmd', 'pending', `CREATE INDEX CONCURRENTLY IF NOT EXISTS pending_idx ON ${ctx.schema}.pending_test (a)`)

        const failed = waitForBamEvent(boss, 'pending_cmd', 'failed')
        await triggerBamPoll(ctx.schema)
        const event = await failed

        expect(event.error).toContain('index pending_idx does not exist after the build')
        expect(errors).toEqual([])
      } finally {
        await pool.close()
      }
    }, 30000)

    // Left running without its client, the UPDATE would apply once the lock is released, while its row
    // read failed and was due to run it again.
    it('should roll back a data migration it stops instead of leaving it to commit', async function () {
      const db = await helper.getDb()
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      await db.executeSql(`CREATE TABLE ${ctx.schema}.migrate_test (id int PRIMARY KEY, n int)`)
      await db.executeSql(`INSERT INTO ${ctx.schema}.migrate_test VALUES (1, 0)`)
      await ctx.boss.stop()

      const holder = await holdOpen(`SELECT * FROM ${ctx.schema}.migrate_test FOR UPDATE`)

      try {
        const { boss, errors } = await startCommand('migrate_cmd', `UPDATE ${ctx.schema}.migrate_test SET n = n + 1`)

        await boss.stop({ timeout: 1000 })

        expect((await readRow('migrate_cmd')).status).toBe('failed')
        expect(errors).toEqual([])
      } finally {
        await holder.query('ROLLBACK')
        await holder.end()
      }

      await delay(1000)

      const { rows } = await db.executeSql(`SELECT n FROM ${ctx.schema}.migrate_test`)
      await db.close()

      expect(Number(rows[0].n)).toBe(0)
    }, 30000)

    // The cancel goes through a role that can read the statement in pg_stat_activity but not signal
    // its backend, so pg_cancel_backend fails. stop() reports that once, waits for the command, and
    // still reports the command's own failure.
    helper.itPostgresOnly('should report a cancel it is not allowed to make once and wait for the command', async function () {
      const role = `bam_cancel_${Math.random().toString(36).slice(2, 10)}`
      const config = helper.getConfig()
      const pool = await helper.getDb()
      await pool.executeSql(`CREATE ROLE ${role} LOGIN PASSWORD 'p'`)
      await pool.executeSql(`GRANT pg_read_all_stats TO ${role}`)

      const canceller = new pg.Client({ host: config.host, port: Number(config.port), database: config.database, user: role, password: 'p' })
      await canceller.connect()

      try {
        const db = {
          executeSql: (text: string, values?: unknown[]) => text.includes('pg_cancel_backend')
            ? canceller.query(text, values)
            : pool.executeSql(text, values)
        }
        const command = "DO $$ BEGIN PERFORM pg_sleep(3); RAISE EXCEPTION 'command failed'; END $$"
        const { boss, errors } = await startCommand('denied_cmd', command, { db })

        const begun = Date.now()
        await boss.stop({ timeout: 1000 })

        expect(Date.now() - begun).toBeGreaterThan(1500)
        expect(errors.map(err => err.message)).toEqual([
          'permission denied to cancel query',
          'command failed'
        ])

        const row = await readRow('denied_cmd')
        expect(row.status).toBe('failed')
        expect(row.error).toContain('command failed')
      } finally {
        await canceller.end()
        await pool.executeSql(`DROP ROLE ${role}`)
        await pool.close()
      }
    }, 30000)

    // CockroachDB index builds do not wait on open snapshots, so only Postgres can park one.
    helper.itPostgresOnly('should leave an index build running on the server and complete its row once it finishes', async function () {
      const db = await helper.getDb()
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      await db.executeSql(`CREATE TABLE ${ctx.schema}.abandon_test (a int)`)
      await ctx.boss.stop()

      // A snapshot on the table parks CREATE INDEX CONCURRENTLY in its wait phase.
      const holder = await holdOpen(`SELECT * FROM ${ctx.schema}.abandon_test`)

      try {
        const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS abandon_idx ON ${ctx.schema}.abandon_test (a)`
        const { boss, errors } = await startCommand('abandon_cmd', command)

        const begun = Date.now()
        await boss.stop({ timeout: 1000 })

        expect(Date.now() - begun).toBeLessThan(10000)
        expect((await readRow('abandon_cmd')).status).toBe('in_progress')
        expect(errors).toEqual([])

        // Past the grace window, so only the build's table lock keeps another instance off the row.
        await db.executeSql(`UPDATE ${ctx.schema}.bam SET started_on = now() - interval '1 hour' WHERE name = 'abandon_cmd'`)

        const restarted = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
        restarted.on('error', () => {})
        await triggerBamPoll(ctx.schema)
        await delay(2500)

        expect((await readRow('abandon_cmd')).status).toBe('in_progress')
      } finally {
        await holder.query('ROLLBACK')
        await holder.end()
      }

      // The build finishes on the server, and the next attempt finds the index valid.
      await triggerBamPoll(ctx.schema)
      await waitForBamStatus(ctx.schema, 'abandon_cmd', 'completed', 10000)

      const { rows } = await db.executeSql(
        `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = '${ctx.schema}.abandon_idx'::regclass`
      )
      await db.close()

      expect(rows[0].valid).toBe(true)
    }, 30000)
  })

  describe('successful execution', function () {
    it('should mark command as completed on success', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      await insertBamCommand(ctx.schema, 'test_success_1', 'SELECT 1')

      const bamEventPromise = waitForBamEvent(boss, 'test_success_1', 'completed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const bamStatus = await boss.getBamEntries()
      const entry = bamStatus.find((e: any) => e.name === 'test_success_1')

      helper.assertTruthy(entry)
      expect(entry.status).toBe('completed')
      expect(entry.completedOn).toBeDefined()
    }, 10000)

    it('should emit bam events for in_progress and completed', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const bamEvents: any[] = []
      boss.on('bam', (event: any) => {
        bamEvents.push(event)
      })

      await insertBamCommand(ctx.schema, 'test_events', 'SELECT 1')

      const bamEventPromise = waitForBamEvent(boss, 'test_events', 'completed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const inProgressEvent = bamEvents.find(e => e.name === 'test_events' && e.status === 'in_progress')
      const completedEvent = bamEvents.find(e => e.name === 'test_events' && e.status === 'completed')

      expect(inProgressEvent).toBeDefined()
      expect(completedEvent).toBeDefined()
      expect(completedEvent.error).toBeUndefined()
    }, 10000)
  })
})
