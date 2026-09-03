import { it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss, getIndexBloatPlans } from '../src/index.ts'
import pg from 'pg'
import type { IDatabase, Warning } from '../src/types.ts'
import { delay } from '../src/tools.ts'

// Enough rows that job_common_i11 and job_common_pkey both clear the 128-page (1 MB) floor once the
// rows are deleted: the heap truncates, the btrees keep every page they grew.
const BLOAT_ROWS = 60_000

async function fillAndDrain (schema: string, queue: string, rows = BLOAT_ROWS) {
  const db = await helper.getDb()

  try {
    // start_after is spread so the leading index column varies — a constant would let btree
    // deduplication compress the entries into posting lists and the index would never grow.
    await db.executeSql(`
      INSERT INTO ${schema}.job (id, name, data, start_after, keep_until, policy)
      SELECT gen_random_uuid(), $1, '{}'::jsonb, now() + (random() * interval '1 day'), now() + interval '14 days', 'standard'
      FROM generate_series(1, ${rows})
    `, [queue])

    await db.executeSql(`DELETE FROM ${schema}.job WHERE name = $1`, [queue])
    // relpages/reltuples are only refreshed by VACUUM/ANALYZE, and the density check reads them.
    await db.executeSql(`VACUUM (ANALYZE) ${schema}.job_common`)
  } finally {
    await db.close()
  }
}

async function indexSizes (schema: string): Promise<Record<string, number>> {
  const db = await helper.getDb()

  try {
    const { rows } = await db.executeSql(`
      SELECT c.relname as name, pg_relation_size(c.oid)::bigint as bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname IN ('job_common_i11', 'job_common_pkey')
    `, [schema])

    return Object.fromEntries(rows.map(r => [r.name, Number(r.bytes)]))
  } finally {
    await db.close()
  }
}

// Delegates every statement to the real database, letting a test rewrite specific ones so failures
// come back from the server rather than from a stub.
function interceptingDb (db: IDatabase, rewrite: (text: string) => string | null): IDatabase {
  return {
    executeSql: (text: string, values?: unknown[]) => db.executeSql(rewrite(text) ?? text, values)
  }
}

async function collectWarnings (schema: string, type: string) {
  const db = await helper.getDb()

  try {
    const { rows } = await db.executeSql(
      `SELECT type, message, data FROM ${schema}.warning WHERE type = $1 ORDER BY created_on`, [type])
    return rows
  } finally {
    await db.close()
  }
}

helper.describePostgresOnly('reindex', function () {
  it('finds no bloat on a fresh installation', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('quiet')

    expect(await boss.getReindexCommands()).toEqual([])
  })

  it('detects a drained backlog as bloat', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const commands = await boss.getReindexCommands()

    expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i11"`)
    expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_pkey"`)
  })

  it('rebuilds bloated indexes during supervise', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const before = await indexSizes(ctx.schema)
    expect(before.job_common_i11).toBeGreaterThan(1024 * 1024)
    expect(before.job_common_pkey).toBeGreaterThan(1024 * 1024)

    await boss.supervise()

    const after = await indexSizes(ctx.schema)
    // The rebuilt indexes hold no live entries at all, so they collapse to a page or two.
    expect(after.job_common_i11).toBeLessThan(64 * 1024)
    expect(after.job_common_pkey).toBeLessThan(64 * 1024)
    expect(await boss.getReindexCommands()).toEqual([])
  })

  it('leaves a healthy index alone', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('busy')

    const db = await helper.getDb()
    await db.executeSql(`
      INSERT INTO ${ctx.schema}.job (id, name, data, start_after, keep_until, policy)
      SELECT gen_random_uuid(), 'busy', '{}'::jsonb, now() + (random() * interval '1 day'), now() + interval '14 days', 'standard'
      FROM generate_series(1, ${BLOAT_ROWS})
    `)
    await db.executeSql(`VACUUM (ANALYZE) ${ctx.schema}.job_common`)
    await db.close()

    // Densely packed: same page count, but every entry is live.
    expect(await boss.getReindexCommands()).toEqual([])

    const before = await indexSizes(ctx.schema)
    await boss.supervise()
    const after = await indexSizes(ctx.schema)

    expect(after.job_common_i11).toBe(before.job_common_i11)
    expect(after.job_common_pkey).toBe(before.job_common_pkey)
  })

  it('warns instead of rebuilding when reindex is disabled', async function () {
    const warnings: Warning[] = []
    const boss = ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noDefault: true,
      supervise: false,
      reindex: false,
      persistWarnings: true
    })
    boss.on('warning', w => warnings.push(w as Warning))

    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const before = await indexSizes(ctx.schema)
    await boss.supervise()
    const after = await indexSizes(ctx.schema)

    expect(after.job_common_i11).toBe(before.job_common_i11)

    const bloatWarnings = warnings.filter(w => w.message.includes('is bloated'))
    expect(bloatWarnings.length).toBeGreaterThan(0)
    expect(bloatWarnings[0].message).toContain('automatic reindexing is disabled')

    const persisted = await collectWarnings(ctx.schema, 'index_bloat')
    expect(persisted.length).toBe(bloatWarnings.length)
  })

  it('leaves the shared interval claim alone when it can only report', async function () {
    // A peer that would have rebuilt has to still find the window open: the claim is what makes one
    // instance per interval do the work, and an instance that never rebuilds taking it would cost
    // the cluster a whole window. The detection-only pass rate-limits itself in memory instead.
    const reporter = ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noDefault: true,
      supervise: false,
      reindex: false
    })

    await reporter.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')
    await reporter.supervise()

    const db = await helper.getDb()

    try {
      const { rows } = await db.executeSql(`SELECT reindex_on FROM ${ctx.schema}.version`)
      expect(rows[0].reindex_on).toBeNull()
    } finally {
      await db.close()
    }

    // Same instance, rebuilds enabled for this pass only: the claim is there to be taken.
    const before = await indexSizes(ctx.schema)
    expect(before.job_common_i11).toBeGreaterThan(1024 * 1024)

    await reporter.supervise(undefined, { reindex: true })

    expect((await indexSizes(ctx.schema)).job_common_i11).toBeLessThan(64 * 1024)
  })

  it('checks each job table once per pass, not once per queue', async function () {
    // Queues are iterated in groups during a pass, but reindexing is table-wide and job_common is
    // shared by every unpartitioned queue, so the check belongs to the pass rather than the loop.
    let claims = 0
    let detections = 0
    const db = await helper.getDb()

    try {
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        noDefault: true,
        supervise: false,
        reindexIntervalSeconds: 60,
        db: interceptingDb(db, text => {
          if (text.includes('reindex_on')) claims++
          // reltuples is unique to the two detection queries; the leftover sweep shares pg_has_role.
          if (text.includes('reltuples')) detections++
          return null
        })
      })

      for (let i = 0; i < 6; i++) {
        await boss.createQueue(`shared${i}`)
      }

      await boss.createQueue('own', { partition: true })
      await fillAndDrain(ctx.schema, 'shared0')

      // Counted from here: startup migrations touch the same version row.
      claims = 0
      detections = 0

      await boss.supervise()

      // Eight queues across two tables: one claim, one catalog read.
      expect({ claims, detections }).toEqual({ claims: 1, detections: 1 })

      // Inside the window the claim returns no row and the catalog is never read.
      await boss.supervise()
      expect(claims).toBe(2)
      expect(detections).toBe(1)
    } finally {
      await db.close()
    }
  })

  it('rate-limits a detection-only pass without the shared claim', async function () {
    let detections = 0
    const db = await helper.getDb()

    try {
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        noDefault: true,
        supervise: false,
        reindex: false,
        reindexIntervalSeconds: 1,
        db: interceptingDb(db, text => {
          if (text.includes('reltuples')) detections++
          return null
        })
      })

      await boss.createQueue('churn')
      await fillAndDrain(ctx.schema, 'churn')

      await boss.supervise()
      expect(detections).toBe(1)

      // Inside the local window the pass returns before it touches the catalog.
      await boss.supervise()
      expect(detections).toBe(1)

      await delay(1100)
      await boss.supervise()
      expect(detections).toBe(2)
    } finally {
      await db.close()
    }
  })

  it('warns only once per bloated index', async function () {
    const warnings: string[] = []
    const boss = ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noDefault: true,
      supervise: false,
      reindex: false,
      reindexIntervalSeconds: 1
    })
    boss.on('warning', w => warnings.push((w as Warning).message))

    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    await boss.supervise()
    const first = warnings.filter(m => m.includes('is bloated')).length
    expect(first).toBeGreaterThan(0)

    // Two further passes over the same still-bloated indexes. The waits are so the one-second
    // interval claim is actually available again — otherwise the passes would return early and the
    // assertion would hold for the wrong reason.
    await delay(1100)
    await boss.supervise()
    await delay(1100)
    await boss.supervise()

    expect(warnings.filter(m => m.includes('is bloated')).length).toBe(first)
  })

  it('skips the whole pass on a backend that stores data outside the heap', async function () {
    // CockroachDB and YugabyteDB cannot run the detection query meaningfully — CockroachDB throws
    // on it, YugabyteDB reports every relation as zero pages — so the flag has to skip detection
    // too, not just the rebuild. Nothing at all should happen here: no rebuild, no warning, no
    // error, and no interval claim consumed.
    const events: string[] = []
    const boss = ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noDefault: true,
      supervise: false,
      __test__noReindex: true
    })
    boss.on('warning', w => events.push((w as Warning).message))
    boss.on('error', (err: Error) => events.push(err.message))

    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const before = await indexSizes(ctx.schema)
    await boss.supervise()
    const after = await indexSizes(ctx.schema)

    expect(after.job_common_i11).toBe(before.job_common_i11)
    expect(events).toEqual([])

    const db = await helper.getDb()
    const { rows } = await db.executeSql(`SELECT reindex_on FROM ${ctx.schema}.version`)
    await db.close()

    expect(rows[0].reindex_on).toBeNull()

    // Same gate on the operator-facing list: the query it runs is the one these engines reject.
    expect(await boss.getReindexCommands()).toEqual([])
    expect(await boss.getReindexCommands({ force: true })).toEqual([])
  })

  it('skips an index larger than maxIndexBytes', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const before = await indexSizes(ctx.schema)
    await boss.supervise(undefined, { reindex: { maxIndexBytes: 1024 } })
    const after = await indexSizes(ctx.schema)

    expect(after.job_common_i11).toBe(before.job_common_i11)
    expect(after.job_common_pkey).toBe(before.job_common_pkey)
  })

  it('rebuilds every job index under force', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('tiny')

    // Nothing qualifies on the density check, so only force reaches these.
    const commands = await boss.getReindexCommands({ force: true })

    expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i11"`)
    expect(commands.length).toBeGreaterThan(2)

    await expect(boss.supervise(undefined, { reindex: { force: true } })).resolves.toBeUndefined()
  })

  it('claims the interval so only one pass runs per window', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    // First pass claims version.reindex_on and rebuilds.
    await boss.supervise()
    const after = await indexSizes(ctx.schema)
    expect(after.job_common_i11).toBeLessThan(64 * 1024)

    const db = await helper.getDb()
    const { rows } = await db.executeSql(`SELECT reindex_on FROM ${ctx.schema}.version`)
    await db.close()

    expect(rows[0].reindex_on).not.toBeNull()

    // A second pass inside the same window finds the claim taken and returns without querying the
    // catalog at all — proven by re-bloating and observing that nothing is rebuilt.
    await fillAndDrain(ctx.schema, 'churn')
    const before = await indexSizes(ctx.schema)
    await boss.supervise()
    expect((await indexSizes(ctx.schema)).job_common_i11).toBe(before.job_common_i11)
  })

  it('drops invalid _ccnew leftovers before rebuilding', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const db = await helper.getDb()
    // Stand in for the stub an interrupted REINDEX CONCURRENTLY leaves behind: same name shape,
    // marked invalid in the catalog.
    await db.executeSql(`CREATE INDEX job_common_i11_ccnew ON ${ctx.schema}.job_common (name, start_after)`)
    await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.job_common_i11_ccnew'::regclass`)

    const commands = await boss.getReindexCommands()
    expect(commands).toContain(`DROP INDEX CONCURRENTLY IF EXISTS ${ctx.schema}."job_common_i11_ccnew"`)
    expect(commands.indexOf(`DROP INDEX CONCURRENTLY IF EXISTS ${ctx.schema}."job_common_i11_ccnew"`))
      .toBeLessThan(commands.indexOf(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i11"`))

    await boss.supervise()

    const { rows } = await db.executeSql(`SELECT to_regclass('${ctx.schema}.job_common_i11_ccnew') as name`)
    await db.close()

    expect(rows[0].name).toBeNull()
  })

  it('drops a stub whose name postgres truncated to fit 63 bytes', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn', { partition: true })

    const db = await helper.getDb()

    try {
      const { rows: [queue] } = await db.executeSql(`SELECT table_name FROM ${ctx.schema}.queue WHERE name = 'churn'`)
      const table = queue.table_name

      await db.executeSql(`
        INSERT INTO ${ctx.schema}.job (id, name, data, start_after, keep_until, policy)
        SELECT gen_random_uuid(), 'churn', '{}'::jsonb, now() + (random() * interval '1 day'), now() + interval '14 days', 'standard'
        FROM generate_series(1, ${BLOAT_ROWS})
      `)
      await db.executeSql(`DELETE FROM ${ctx.schema}.job WHERE name = 'churn'`)
      await db.executeSql(`VACUUM (ANALYZE) ${ctx.schema}.${table}`)

      // Postgres does not append `_ccnew` — it truncates the base so the whole name fits in 63
      // bytes. A partition table is `'j' || sha224(queue_name)` (57 chars), so its `_i11` index is
      // 61 and the stub loses the `i11` entirely. Pairing a stub to its index by name prefix would
      // therefore miss every partitioned queue.
      const stub = `${table}_ccnew`

      expect(stub.length).toBe(63)
      expect(stub.startsWith(`${table}_i11_ccnew`)).toBe(false)

      await db.executeSql(`CREATE INDEX ${stub} ON ${ctx.schema}.${table} (name, start_after)`)
      await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.${stub}'::regclass`)

      const commands = await boss.getReindexCommands()
      const drop = `DROP INDEX CONCURRENTLY IF EXISTS ${ctx.schema}."${stub}"`

      expect(commands).toContain(drop)
      expect(commands.indexOf(drop)).toBeLessThan(commands.findIndex(c => c.startsWith('REINDEX')))

      await boss.supervise()

      const { rows } = await db.executeSql(`SELECT to_regclass('${ctx.schema}.${stub}') as name`)
      expect(rows[0].name).toBeNull()
    } finally {
      await db.close()
    }
  })

  // Skipped on PGlite: this needs a second connection authenticated as a different role, and PGlite
  // is a single in-process instance with no server to connect to (getConfig() leaves host/port
  // undefined there, so a second pool would fall back to 127.0.0.1:5432 and be refused).
  helper.itPglite('reports bloat a non-owning role cannot rebuild, rather than failing', async function () {
    // The whole point of filtering on ownership in the catalog query is that a role without rights
    // never issues a REINDEX it would only be refused for. Proven from a second connection: the test
    // user is a superuser (a member of every role), so the distinction is invisible from there.
    const owner = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await owner.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const config = helper.getConfig({ schema: ctx.schema }) as Record<string, any>
    const role = `pgboss_nonowner_${process.pid}`
    const db = await helper.getDb()

    await db.executeSql(`DROP ROLE IF EXISTS ${role}`)
    await db.executeSql(`CREATE ROLE ${role} LOGIN PASSWORD 'nonowner'`)
    await db.executeSql(`GRANT USAGE ON SCHEMA ${ctx.schema} TO ${role}`)
    await db.executeSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ctx.schema} TO ${role}`)

    const warnings: string[] = []
    const guest = new PgBoss({
      host: config.host,
      port: config.port,
      database: config.database,
      user: role,
      password: 'nonowner',
      schema: ctx.schema,
      migrate: false,
      supervise: false
    })
    guest.on('warning', w => warnings.push((w as Warning).message))

    try {
      await guest.start()

      const before = await indexSizes(ctx.schema)
      await guest.supervise()
      const after = await indexSizes(ctx.schema)

      expect(after.job_common_i11).toBe(before.job_common_i11)
      expect(after.job_common_pkey).toBe(before.job_common_pkey)
      expect(warnings.some(m => m.includes('does not own the index'))).toBe(true)

      // The command list is for an operator who may run it as the owner, so it withholds nothing —
      // including the DROP for a stub owned by someone else, which has to precede its REINDEX.
      const db2 = await helper.getDb()

      try {
        await db2.executeSql(`CREATE INDEX job_common_i11_ccnew ON ${ctx.schema}.job_common (name, start_after)`)
        await db2.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.job_common_i11_ccnew'::regclass`)

        const commands = await guest.getReindexCommands()
        expect(commands).toContain(`DROP INDEX CONCURRENTLY IF EXISTS ${ctx.schema}."job_common_i11_ccnew"`)
        expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i11"`)
      } finally {
        await db2.executeSql(`DROP INDEX IF EXISTS ${ctx.schema}.job_common_i11_ccnew`).catch(() => {})
        await db2.close()
      }
    } finally {
      await guest.stop({ graceful: false }).catch(() => {})
      await db.executeSql(`REVOKE ALL ON ALL TABLES IN SCHEMA ${ctx.schema} FROM ${role}`)
      await db.executeSql(`REVOKE USAGE ON SCHEMA ${ctx.schema} FROM ${role}`)
      await db.executeSql(`DROP ROLE IF EXISTS ${role}`)
      await db.close()
    }
  })

  it('applies maxIndexBytes to the exported command list only when asked', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    // No cap by default here, unlike the background pass: the commands are for an operator running
    // them deliberately, so omitting a large index from the list would be the surprising behavior.
    expect((await boss.getReindexCommands()).length).toBeGreaterThan(0)
    expect(await boss.getReindexCommands({ maxIndexBytes: 1024 })).toEqual([])
  })

  it('warns and carries on when a rebuild fails for a reason other than a transaction', async function () {
    const warnings: string[] = []
    const db = await helper.getDb()

    try {
      // Redirect the rebuild at an index that isn't there, so the failure is a real server error
      // with a SQLSTATE that isn't 25001. Every bloated index should still be attempted.
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        noDefault: true,
        supervise: false,
        db: interceptingDb(db, text =>
          text.startsWith('REINDEX') ? `REINDEX INDEX CONCURRENTLY ${ctx.schema}."no_such_index"` : null)
      })
      boss.on('warning', w => warnings.push((w as Warning).message))

      await boss.createQueue('churn')
      await fillAndDrain(ctx.schema, 'churn')

      const before = await indexSizes(ctx.schema)
      await boss.supervise()
      const after = await indexSizes(ctx.schema)

      expect(after.job_common_i11).toBe(before.job_common_i11)
      expect(warnings.filter(m => m.includes('does not exist')).length).toBe(2)
    } finally {
      await db.close()
    }
  })

  it('emits an error but still rebuilds when the leftover sweep fails', async function () {
    const errors: string[] = []
    const db = await helper.getDb()

    try {
      const boss = ctx.boss = await helper.start({
        ...ctx.bossConfig,
        noDefault: true,
        supervise: false,
        db: interceptingDb(db, text => text.includes('_ccnew') ? 'SELECT this_is_not_valid_sql' : null)
      })
      boss.on('error', (err: Error) => errors.push(err.message))

      await boss.createQueue('churn')
      await fillAndDrain(ctx.schema, 'churn')

      await boss.supervise()

      // Dropping stale stubs is best effort — the rebuild it precedes must not be lost with it.
      expect(errors.length).toBeGreaterThan(0)
      expect((await indexSizes(ctx.schema)).job_common_i11).toBeLessThan(64 * 1024)
    } finally {
      await db.close()
    }
  })

  // Needs a second, session-pinned connection to hold an explicit transaction open, which PGlite
  // (single in-process instance) cannot provide.
  helper.itPglite('gives up on rebuilds when the adapter wraps queries in a transaction', async function () {
    const owner = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await owner.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const config = helper.getConfig({ schema: ctx.schema }) as Record<string, any>
    const client = new pg.Client({
      host: config.host, port: config.port, database: config.database, user: config.user, password: config.password
    })
    await client.connect()

    // A real transaction, not a stubbed error: Postgres itself raises SQLSTATE 25001 for a REINDEX
    // CONCURRENTLY issued inside one, which is exactly what a transaction-wrapping db adapter does.
    let reindexAttempts = 0
    const warnings: string[] = []
    const guest = new PgBoss({
      schema: ctx.schema,
      migrate: false,
      supervise: false,
      reindexIntervalSeconds: 1,
      db: {
        executeSql: async (text: string, values?: unknown[]) => {
          if (!text.startsWith('REINDEX')) return client.query(text, values as unknown[])

          reindexAttempts++
          await client.query('BEGIN')
          try {
            return await client.query(text, values as unknown[])
          } finally {
            await client.query('ROLLBACK')
          }
        }
      }
    })
    guest.on('warning', w => warnings.push((w as Warning).message))

    try {
      await guest.start()

      const before = await indexSizes(ctx.schema)
      await guest.supervise()

      expect((await indexSizes(ctx.schema)).job_common_i11).toBe(before.job_common_i11)
      // Both indexes report the wrapper, not just the one that was attempted: the others were
      // skipped by the giveup, so a size-cap message would name a limit they are nowhere near.
      expect(warnings.filter(m => m.includes('cannot run inside a transaction block')).length).toBe(2)
      expect(warnings.some(m => m.includes('larger than maxIndexBytes'))).toBe(false)

      // Both bloated indexes are candidates, but the wrapper is a property of the adapter rather
      // than of one index, so the pass stops after the first and never retries on a later one.
      expect(reindexAttempts).toBe(1)

      await delay(1100)
      await guest.supervise()
      expect(reindexAttempts).toBe(1)
    } finally {
      await guest.stop({ graceful: false }).catch(() => {})
      await client.end()
    }
  })

  it('ignores an index whose stats have never been collected', async function () {
    // PG 14+ writes reltuples = -1 for a relation that has never been vacuumed or analyzed (PG 13
    // wrote 0). A negative count is under any density and produces a negative expected size, so
    // without the guard it would pass every gate on stats that mean "unknown", not "empty".
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    expect((await boss.getReindexCommands()).length).toBeGreaterThan(0)

    const db = await helper.getDb()

    try {
      await db.executeSql(`UPDATE pg_class SET reltuples = -1 WHERE oid = '${ctx.schema}.job_common_i11'::regclass`)

      const commands = await boss.getReindexCommands()
      expect(commands).not.toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i11"`)
      expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_pkey"`)
    } finally {
      await db.close()
    }
  })

  // Needs two extra connections — one to hold a snapshot open, one to sit in the blocked rebuild —
  // which PGlite (single in-process instance) cannot provide.
  helper.itPglite('leaves a stub alone while a rebuild is actually running', async function () {
    // An in-flight REINDEX CONCURRENTLY's transient index is invalid too, and nothing in the catalog
    // separates it from the wreckage of one that died. force skips the interval claim, so two passes
    // can overlap — without the liveness check one would drop the index the other is building.
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const db = await helper.getDb()
    const config = helper.getConfig({ schema: ctx.schema }) as Record<string, any>
    const connection = () => new pg.Client({
      host: config.host, port: config.port, database: config.database, user: config.user, password: config.password
    })

    const holder = connection()
    const builder = connection()

    try {
      await db.executeSql(`CREATE INDEX job_common_i11_ccnew ON ${ctx.schema}.job_common (name, start_after)`)
      await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.job_common_i11_ccnew'::regclass`)

      const drop = `DROP INDEX CONCURRENTLY IF EXISTS ${ctx.schema}."job_common_i11_ccnew"`
      expect(await boss.getReindexCommands()).toContain(drop)

      // A real build, held in its wait phase rather than raced: REINDEX CONCURRENTLY waits out every
      // transaction older than itself, so an open snapshot on another connection keeps it running —
      // and registered in pg_stat_progress_create_index — for as long as the test needs.
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query(`SELECT 1 FROM ${ctx.schema}.job_common LIMIT 1`)

      await builder.connect()
      const building = builder.query(`REINDEX INDEX CONCURRENTLY ${ctx.schema}.job_common_pkey`)

      let live = 0

      while (!live) {
        const { rows } = await db.executeSql(
          `SELECT count(*)::int as count FROM pg_stat_progress_create_index WHERE relid = '${ctx.schema}.job_common'::regclass`)
        live = rows[0].count
      }

      expect(await boss.getReindexCommands()).not.toContain(drop)

      await holder.query('COMMIT')
      await building

      // Once nothing is building, the same stub is a leftover again.
      expect(await boss.getReindexCommands()).toContain(drop)
    } finally {
      await holder.query('COMMIT').catch(() => {})
      await holder.end().catch(() => {})
      await builder.end().catch(() => {})
      await db.close()
    }
  })

  it('exports the detection query without a connection', function () {
    const sql = getIndexBloatPlans('pgboss')

    expect(sql).toContain('pg_has_role')
    expect(sql).toContain("n.nspname = 'pgboss'")
    expect(sql).toContain('i.relpages > 128')
    expect(sql).toContain('i.relpages > 4 * GREATEST(ceil((i.reltuples * (w.key_width + 20)) / 8192.0), 1)')
    expect(getIndexBloatPlans('pgboss', { minPages: 4, maxEntriesPerPage: 2 })).toContain('i.relpages > 4')
    expect(getIndexBloatPlans('pgboss', { minSizeRatio: 9 })).toContain('i.relpages > 9 * GREATEST(ceil')
  })

  it('leaves a sparse index alone when it is no larger than its entries need', async function () {
    // Density alone cannot tell bloat from a legitimately wide key: singleton_key is unbounded text,
    // and an index over ~1.3 kB keys holds fewer than five entries per page while perfectly packed
    // (measured: 150k distinct 1,286-byte keys, freshly built, 4.0 entries/page, expected-size ratio
    // 1.6). The pg_stats size ratio is what separates the two. Asserted through the option rather
    // than a 300 MB fixture: with the ratio raised past anything reachable, indexes that ARE bloated
    // stop qualifying.
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    expect((await boss.getReindexCommands()).length).toBeGreaterThan(0)
    expect(await boss.getReindexCommands({ minSizeRatio: 1_000_000 })).toEqual([])

    const before = await indexSizes(ctx.schema)
    await boss.supervise(undefined, { reindex: { minSizeRatio: 1_000_000 } })
    const after = await indexSizes(ctx.schema)

    expect(after.job_common_i11).toBe(before.job_common_i11)
    expect(after.job_common_pkey).toBe(before.job_common_pkey)
  })

  it('reports index size and entry count as numbers', async function () {
    // pg_relation_size() and reltuples::bigint are int8, which node-postgres returns as a string
    // unless the query casts. IndexBloat declares them as numbers and the warning carries them to
    // user code, so the cast has to hold.
    const warnings: Warning[] = []
    const boss = ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noDefault: true,
      supervise: false,
      reindex: false
    })
    boss.on('warning', w => warnings.push(w as Warning))

    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')
    await boss.supervise()

    const data = warnings.find(w => w.message.includes('is bloated'))?.data as { bytes: number, entries: number, pages: number }

    expect(typeof data.bytes).toBe('number')
    expect(typeof data.entries).toBe('number')
    expect(typeof data.pages).toBe('number')
    expect(data.bytes).toBeGreaterThan(1024 * 1024)
  })

  it('rejects a non-numeric threshold passed per call', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')

    // supervise() takes these per call, where the constructor's validation never runs, and they are
    // interpolated into the detection query.
    await expect(boss.getReindexCommands({ minPages: '0 OR true; --' as never }))
      .rejects.toThrow('reindex.minPages must be a finite number >= 0')

    await expect(boss.supervise(undefined, { reindex: { maxEntriesPerPage: Number.NaN } }))
      .rejects.toThrow('reindex.maxEntriesPerPage must be a finite number >= 0')
  })
})
