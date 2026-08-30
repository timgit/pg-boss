import { it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss, getIndexBloatPlans } from '../src/index.ts'
import type { Warning } from '../src/types.ts'
import { delay } from '../src/tools.ts'

// Enough rows that job_common_i5 and job_common_pkey both clear the 128-page (1 MB) floor once the
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
      WHERE n.nspname = $1 AND c.relname IN ('job_common_i5', 'job_common_pkey')
    `, [schema])

    return Object.fromEntries(rows.map(r => [r.name, Number(r.bytes)]))
  } finally {
    await db.close()
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

    expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i5"`)
    expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_pkey"`)
  })

  it('rebuilds bloated indexes during supervise', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const before = await indexSizes(ctx.schema)
    expect(before.job_common_i5).toBeGreaterThan(1024 * 1024)
    expect(before.job_common_pkey).toBeGreaterThan(1024 * 1024)

    await boss.supervise()

    const after = await indexSizes(ctx.schema)
    // The rebuilt indexes hold no live entries at all, so they collapse to a page or two.
    expect(after.job_common_i5).toBeLessThan(64 * 1024)
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

    expect(after.job_common_i5).toBe(before.job_common_i5)
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

    expect(after.job_common_i5).toBe(before.job_common_i5)

    const bloatWarnings = warnings.filter(w => w.message.includes('is bloated'))
    expect(bloatWarnings.length).toBeGreaterThan(0)
    expect(bloatWarnings[0].message).toContain('automatic reindexing is disabled')

    const persisted = await collectWarnings(ctx.schema, 'index_bloat')
    expect(persisted.length).toBe(bloatWarnings.length)
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
      __test__noConcurrentReindex: true
    })
    boss.on('warning', w => events.push((w as Warning).message))
    boss.on('error', (err: Error) => events.push(err.message))

    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const before = await indexSizes(ctx.schema)
    await boss.supervise()
    const after = await indexSizes(ctx.schema)

    expect(after.job_common_i5).toBe(before.job_common_i5)
    expect(events).toEqual([])

    const db = await helper.getDb()
    const { rows } = await db.executeSql(`SELECT reindex_on FROM ${ctx.schema}.version`)
    await db.close()

    expect(rows[0].reindex_on).toBeNull()
  })

  it('skips an index larger than maxIndexBytes', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const before = await indexSizes(ctx.schema)
    await boss.supervise(undefined, { reindex: { maxIndexBytes: 1024 } })
    const after = await indexSizes(ctx.schema)

    expect(after.job_common_i5).toBe(before.job_common_i5)
    expect(after.job_common_pkey).toBe(before.job_common_pkey)
  })

  it('rebuilds every job index under force', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('tiny')

    // Nothing qualifies on the density check, so only force reaches these.
    const commands = await boss.getReindexCommands({ force: true })

    expect(commands).toContain(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i5"`)
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
    expect(after.job_common_i5).toBeLessThan(64 * 1024)

    const db = await helper.getDb()
    const { rows } = await db.executeSql(`SELECT reindex_on FROM ${ctx.schema}.version`)
    await db.close()

    expect(rows[0].reindex_on).not.toBeNull()

    // A second pass inside the same window finds the claim taken and returns without querying the
    // catalog at all — proven by re-bloating and observing that nothing is rebuilt.
    await fillAndDrain(ctx.schema, 'churn')
    const before = await indexSizes(ctx.schema)
    await boss.supervise()
    expect((await indexSizes(ctx.schema)).job_common_i5).toBe(before.job_common_i5)
  })

  it('drops invalid _ccnew leftovers before rebuilding', async function () {
    const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, supervise: false })
    await boss.createQueue('churn')
    await fillAndDrain(ctx.schema, 'churn')

    const db = await helper.getDb()
    // Stand in for the stub an interrupted REINDEX CONCURRENTLY leaves behind: same name shape,
    // marked invalid in the catalog.
    await db.executeSql(`CREATE INDEX job_common_i5_ccnew ON ${ctx.schema}.job_common (name, start_after)`)
    await db.executeSql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ctx.schema}.job_common_i5_ccnew'::regclass`)

    const commands = await boss.getReindexCommands()
    expect(commands).toContain(`DROP INDEX CONCURRENTLY IF EXISTS ${ctx.schema}."job_common_i5_ccnew"`)
    expect(commands.indexOf(`DROP INDEX CONCURRENTLY IF EXISTS ${ctx.schema}."job_common_i5_ccnew"`))
      .toBeLessThan(commands.indexOf(`REINDEX INDEX CONCURRENTLY ${ctx.schema}."job_common_i5"`))

    await boss.supervise()

    const { rows } = await db.executeSql(`SELECT to_regclass('${ctx.schema}.job_common_i5_ccnew') as name`)
    await db.close()

    expect(rows[0].name).toBeNull()
  })

  it('reports bloat a non-owning role cannot rebuild, rather than failing', async function () {
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

      expect(after.job_common_i5).toBe(before.job_common_i5)
      expect(after.job_common_pkey).toBe(before.job_common_pkey)
      expect(warnings.some(m => m.includes('does not own the index'))).toBe(true)
    } finally {
      await guest.stop({ graceful: false }).catch(() => {})
      await db.executeSql(`REVOKE ALL ON ALL TABLES IN SCHEMA ${ctx.schema} FROM ${role}`)
      await db.executeSql(`REVOKE USAGE ON SCHEMA ${ctx.schema} FROM ${role}`)
      await db.executeSql(`DROP ROLE IF EXISTS ${role}`)
      await db.close()
    }
  })

  it('exports the detection query without a connection', function () {
    const sql = getIndexBloatPlans('pgboss')

    expect(sql).toContain('pg_has_role')
    expect(sql).toContain("n.nspname = 'pgboss'")
    expect(sql).toContain('i.relpages > 128')
    expect(getIndexBloatPlans('pgboss', { minPages: 4, maxEntriesPerPage: 2 })).toContain('i.relpages > 4')
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

  it('rejects force in constructor options', function () {
    expect(() => new PgBoss({ ...ctx.bossConfig, reindex: { force: true } }))
      .toThrow('reindex.force cannot be set in constructor options')
  })
})
