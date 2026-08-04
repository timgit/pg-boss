import { describe, it } from 'vitest'
import pg from 'pg'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
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

async function insertBamRow (schema: string, name: string, status: string, command: string, startedAgoSeconds?: number) {
  const db = await helper.getDb()
  const startedOn = startedAgoSeconds != null ? `now() - interval '${startedAgoSeconds} seconds'` : 'NULL'
  await db.executeSql(`
    INSERT INTO ${schema}.bam (name, version, status, table_name, command, started_on)
    VALUES ($1, 27, $2, 'job_common', $3, ${startedOn})
  `, [name, status, command])
  await db.close()
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
          ('test_success', 27, 'pending', 'job_common', 'SELECT 1')
      `)
      await db.close()

      const failPromise = waitForBamEvent(boss, 'test_fail', 'failed')
      const successPromise = waitForBamEvent(boss, 'test_success', 'completed', 10000)

      await triggerBamPoll(ctx.schema)
      await failPromise

      // Trigger another poll for the second command
      await triggerBamPoll(ctx.schema)
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
      // Make it INVALID, as a crashed CREATE INDEX CONCURRENTLY leaves it — healing only drops an
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
      // must also heal on retry — otherwise the command's IF NOT EXISTS skips the stale index forever.
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

    it('does NOT drop a VALID leftover index on reattempt (build succeeded but row was never marked)', async function () {
      // The dangerous case: a CREATE INDEX CONCURRENTLY that actually succeeded (VALID index, in use)
      // but whose bam row stayed in_progress because a graceful stop landed between the CREATE and
      // markCompleted. On reattempt, healing must NOT drop this live index — it should skip the drop,
      // let the command's IF NOT EXISTS no-op, and mark the row completed with the index intact.
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      // Valid index matching what the command builds — stands in for the already-succeeded build.
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)

      const command = `CREATE INDEX CONCURRENTLY IF NOT EXISTS heal_idx ON ${ctx.schema}.heal_test (a)`
      await insertBamRow(ctx.schema, 'valid_cmd', 'in_progress', command, 25 * 60 * 60)

      const done = waitForBamEvent(boss, 'valid_cmd', 'completed')
      await triggerBamPoll(ctx.schema)
      await done

      const { rows } = await db.executeSql(
        `SELECT indexdef, i.indisvalid AS valid
         FROM pg_indexes p JOIN pg_class c ON c.relname = p.indexname
         JOIN pg_index i ON i.indexrelid = c.oid
         WHERE p.schemaname = '${ctx.schema}' AND p.indexname = 'heal_idx'`
      )
      await db.close()

      // Index untouched: still valid, still on (a) — it was never dropped.
      expect(rows).toHaveLength(1)
      expect(rows[0].valid).toBe(true)
      expect(rows[0].indexdef).toContain('(a)')
    }, 10000)

    it('should not heal on backends without pg_stat_progress_create_index (timeout-only reclaim)', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig, __test__noIndexProgressView: true })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.heal_test (a int, b int)`)
      await db.executeSql(`CREATE INDEX heal_idx ON ${ctx.schema}.heal_test (a)`)

      // Same reclaim, but no liveness backend → no drop-then-rebuild. The command's IF NOT EXISTS
      // sees heal_idx and skips, so the pre-existing (a) index survives untouched.
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
  // as "dead" and getting its live index dropped by the heal step. A held ShareUpdateExclusiveLock —
  // the exact lock CREATE INDEX CONCURRENTLY holds for the whole build — must therefore block reclaim.
  helper.describeMultiConnectionOnly('pg_locks liveness (cross-role safe)', function () {
    it('should not reclaim a stale build while a ShareUpdateExclusiveLock is held on its table, then reclaim once released', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`CREATE TABLE ${ctx.schema}.live_tbl (a int)`)
      await db.close()

      // A separate backend stands in for an in-flight CREATE INDEX CONCURRENTLY by holding the very lock
      // one takes — ShareUpdateExclusiveLock — on the build's table for the whole window.
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
