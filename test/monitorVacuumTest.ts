import { it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import pg from 'pg'
import type { PgBoss } from '../src/index.ts'
import type { Warning } from '../src/types.ts'

// Opens a second connection, pins the MVCC horizon with a REPEATABLE READ snapshot, and holds it
// until released. A plain BEGIN is not enough — the snapshot has to be taken (hence the SELECT) for
// backend_xmin to be set, and repeatable read is what keeps it set while the backend sits idle.
async function holdHorizon () {
  const client = new pg.Client(helper.getConnectionString())
  await client.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  await client.query('SELECT 1')

  return async () => {
    await client.query('ROLLBACK')
    await client.end()
  }
}

// One round of real garbage: every fetch and every complete rewrites a row, so each job leaves two
// dead tuples behind.
//
// `vacuum` picks which half of the check the round feeds. VACUUM ANALYZE both refreshes the stats
// view and moves last_vacuum, which is the vacuum a pinned horizon renders useless. Plain ANALYZE
// refreshes the same statistics while leaving last_vacuum untouched, which is what the
// autovacuum_disabled branch needs: garbage growing with no vacuum behind it.
async function churn (boss: PgBoss, queue: string, { vacuum = true } = {}) {
  const count = 100
  await boss.insert(queue, Array.from({ length: count }, () => ({ data: {} })))

  const jobs = await boss.fetch(queue, { batchSize: count })
  await boss.complete(queue, jobs.map(j => j.id))

  const db = await helper.getDb()

  try {
    await db.executeSql(`${vacuum ? 'VACUUM (ANALYZE)' : 'ANALYZE'} ${ctx.schema}.${plans.COMMON_JOB_TABLE}`)
  } finally {
    await db.close()
  }
}

// Per-table storage parameters win over the cluster settings, which is both how an operator tunes
// this check and how these tests pin the budget somewhere deterministic.
async function setStorage (parameter: string) {
  const db = await helper.getDb()

  try {
    await db.executeSql(`ALTER TABLE ${ctx.schema}.${plans.COMMON_JOB_TABLE} SET (${parameter})`)
  } finally {
    await db.close()
  }
}

async function storedWarnings (schema: string, type: string) {
  const db = await helper.getDb()

  try {
    const { rows } = await db.executeSql(
      `SELECT type, message, data FROM ${schema}.warning WHERE type = $1 ORDER BY created_on`, [type])
    return rows
  } finally {
    await db.close()
  }
}

async function startBoss (options: object = {}) {
  const boss = ctx.boss = await helper.start({
    ...ctx.bossConfig,
    noDefault: true,
    supervise: false,
    persistWarnings: true,
    ...options
  })

  await boss.createQueue('garbage')

  return boss
}

helper.describePostgresOnly('vacuum monitoring', function () {
  it('stays quiet while the table is under its own autovacuum budget', async function () {
    const boss = await startBoss()

    // Same workload and the same held horizon as the warning case, with only the budget moved out
    // of reach. Nothing here is worth reporting: Postgres would not vacuum this table yet either.
    //
    // The budget is pinned with a storage parameter rather than by relying on vacuum reclaiming
    // everything, because the suite shares one database — a long transaction in another worker is
    // itself a horizon holder, so "no holder exists" is not a state a test can assert.
    await setStorage('autovacuum_vacuum_scale_factor = 100')

    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()
      await churn(boss, 'garbage')
      await boss.supervise()

      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(0)
    } finally {
      await release()
    }
  })

  it('needs a vacuum to have failed before it warns', async function () {
    const boss = await startBoss()
    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()

      // Over budget already, but only one observation: nothing yet says a vacuum ran and came back
      // empty-handed. A threshold on age alone would have fired here.
      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(0)

      await churn(boss, 'garbage')
      await boss.supervise()

      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(1)
    } finally {
      await release()
    }
  })

  it('stays quiet while over budget if no vacuum has run since', async function () {
    const boss = await startBoss()
    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()

      // Repeated passes with no vacuum in between add no evidence, however much garbage is sitting
      // there — an unvacuumed table says nothing about whether vacuum *could* have reclaimed it.
      await boss.supervise()
      await boss.supervise()

      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(0)
    } finally {
      await release()
    }
  })

  it('names the holder and the table evidence', async function () {
    const warnings: Warning[] = []
    const boss = await startBoss()
    boss.on('warning', w => warnings.push(w))

    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()
      await churn(boss, 'garbage')
      await boss.supervise()

      const [stored] = await storedWarnings(ctx.schema, 'xmin_horizon')

      expect(stored.data.source).toBe('backends')
      expect(stored.data.table).toBe(plans.COMMON_JOB_TABLE)
      expect(stored.data.deadTuples).toBeGreaterThan(stored.data.budget)
      expect(stored.data.unreadableSources).toEqual([])
      // Names the holder class rather than just a number, so the message is actionable.
      expect(stored.message).toContain('backend holding an open transaction')
      expect(stored.message).toContain('could not reclaim')

      // Also emitted, not only persisted — an instance running with persistWarnings off still
      // needs the signal.
      const emitted = warnings.filter(w => w.message.includes('transaction horizon is pinned'))
      expect(emitted).toHaveLength(1)
      expect((emitted[0].data as { source: string }).source).toBe('backends')
    } finally {
      await release()
    }
  })

  it('warns once per episode, not once per pass', async function () {
    const boss = await startBoss()
    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()

      for (let i = 0; i < 3; i++) {
        await churn(boss, 'garbage')
        await boss.supervise()
      }

      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(1)
    } finally {
      await release()
    }
  })

  it('warns again after the table recovers and is pinned a second time', async function () {
    const boss = await startBoss()

    const release = await holdHorizon()
    await churn(boss, 'garbage')
    await boss.supervise()
    await churn(boss, 'garbage')
    await boss.supervise()
    await release()

    // Back under budget: the latch clears rather than staying set for the life of the instance.
    // Moved with a storage parameter for the same reason as above — whether a vacuum can actually
    // reclaim depends on every other worker sharing this database, and is not ours to decide.
    await setStorage('autovacuum_vacuum_scale_factor = 100')
    await churn(boss, 'garbage')
    await boss.supervise()

    // Deliberately far below the 0.2 default for the second episode. By this point the table holds
    // enough live rows that the default budget (50 + 0.2 x live) sits within ~20% of the dead count
    // one churn produces — and n_live_tup / n_dead_tup are collector estimates that drift under a
    // loaded suite, so that margin is thin enough to flip the result. The latch is what this test
    // is about; the budget just needs to be unambiguously exceeded.
    await setStorage('autovacuum_vacuum_scale_factor = 0.01')

    const release2 = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()
      await churn(boss, 'garbage')
      await boss.supervise()

      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(2)
    } finally {
      await release2()
    }
  })

  it('does not run when disabled', async function () {
    const boss = await startBoss({ monitorVacuum: false })
    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()
      await churn(boss, 'garbage')
      await boss.supervise()

      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(0)
    } finally {
      await release()
    }
  })

  it('warns that autovacuum is off rather than blaming the horizon', async function () {
    const boss = await startBoss()

    // Nothing is vacuuming this table, so surviving dead tuples say nothing about the horizon.
    // Reported as its own diagnosis because the fix is the opposite one.
    await setStorage('autovacuum_enabled = false, autovacuum_vacuum_scale_factor = 0.01')

    // No holder held anywhere: this branch must stand on the table evidence alone.
    await churn(boss, 'garbage', { vacuum: false })
    await boss.supervise()
    await churn(boss, 'garbage', { vacuum: false })
    await boss.supervise()

    const [stored] = await storedWarnings(ctx.schema, 'autovacuum_disabled')

    expect(stored.data.table).toBe(plans.COMMON_JOB_TABLE)
    expect(stored.data.deadTuples).toBeGreaterThan(stored.data.budget)
    expect(stored.message).toContain('autovacuum_enabled = false')
    expect(stored.message).toContain('still growing')
    // Never vacuumed at all, so the age is null rather than a misleading 0.
    expect(stored.data.vacuumAgeSeconds).toBeNull()

    // The other diagnosis stays silent: there is no failed vacuum here to blame a holder for.
    expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(0)
  })

  it('stays quiet with autovacuum off while the garbage is not growing', async function () {
    const boss = await startBoss()
    await setStorage('autovacuum_enabled = false, autovacuum_vacuum_scale_factor = 0.01')

    await churn(boss, 'garbage', { vacuum: false })
    await boss.supervise()

    // Over budget and unvacuumed, but static — an operator vacuuming on their own schedule sits
    // here between runs, and has nothing to be told.
    await boss.supervise()
    await boss.supervise()

    expect(await storedWarnings(ctx.schema, 'autovacuum_disabled')).toHaveLength(0)
  })

  it('warns about autovacuum once per episode, not once per pass', async function () {
    const boss = await startBoss()
    await setStorage('autovacuum_enabled = false, autovacuum_vacuum_scale_factor = 0.01')

    for (let i = 0; i < 4; i++) {
      await churn(boss, 'garbage', { vacuum: false })
      await boss.supervise()
    }

    expect(await storedWarnings(ctx.schema, 'autovacuum_disabled')).toHaveLength(1)
  })

  it('rejects a non-boolean setting', async function () {
    const { PgBoss } = await import('../src/index.ts')

    expect(() => new PgBoss({ ...ctx.bossConfig, monitorVacuum: 1_000_000 } as never))
      .toThrow('monitorVacuum must be a boolean')
  })
})
