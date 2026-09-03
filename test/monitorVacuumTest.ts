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
async function holdHorizon (applicationName?: string) {
  const client = new pg.Client(helper.getConnectionString())
  await client.connect()

  if (applicationName) {
    // set_config, not SET: SET takes no bind parameters.
    await client.query('SELECT set_config($1, $2, false)', ['application_name', applicationName])
  }

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

// describeMultiConnectionOnly, not describePostgresOnly: nearly every case here needs a second
// independent connection to hold the horizon while pg-boss observes it, and PGlite has no server to
// open one against (getConnectionString returns a placeholder that fails DNS). The subsystem is not
// meaningfully exercisable there anyway - it reads real autovacuum activity out of
// pg_stat_user_tables against a genuine MVCC horizon.
helper.describeMultiConnectionOnly('vacuum monitoring', function () {
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
      // Identifies the individual backend, not just its class, which is what an operator needs to go
      // and look at the thing. Only the pid is asserted here: which backend wins max(age(backend_xmin))
      // is not this test's to decide on a shared database, and an autovacuum worker that started its
      // per-table transaction before the held horizon qualifies and wins — carrying a NULL usename,
      // since pg_stat_activity leaves usename NULL for every non-client backend. The role, the
      // application_name and the wording built from them are pinned by the staged-holder cases below,
      // where the row is not a race.
      expect(stored.data.holderPid).toBeGreaterThan(0)
      expect(stored.message).toContain(`pid ${stored.data.holderPid}`)
      expect(stored.message).toContain('has held a transaction open')
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

  // Which backend wins max(age(backend_xmin)) is not a test's to decide: the suite shares one
  // database and every other worker's pg-boss is a holder too. So the identity half of the warning
  // is staged by rewriting the horizon row, which also stands in for the case a shared database
  // cannot produce — a backend owned by a different role, whose xact_start reads NULL.
  async function withStagedHolder (row: Record<string, unknown>) {
    const realDb = await helper.getDb()

    return await startBoss({
      db: {
        async executeSql (sql: string, values: any[]) {
          const result = await realDb.executeSql(sql, values)

          if (sql.includes('backendHolder') && result.rows?.length) {
            Object.assign(result.rows[0], row)
          }

          return result
        }
      }
    })
  }

  async function provoke (boss: PgBoss) {
    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()
      await churn(boss, 'garbage')
      await boss.supervise()

      return (await storedWarnings(ctx.schema, 'xmin_horizon'))[0]
    } finally {
      await release()
    }
  }

  it('separates another application from this one by application_name', async function () {
    // A reporting tool holding a long transaction open on the same database is the most common
    // cause of a pinned horizon and the one pg-boss cannot fix for the operator — so it has to be
    // told apart from pg-boss pinning its own horizon, which has an entirely different remedy.
    const boss = await withStagedHolder({
      backendHolder: { pid: 4242, applicationName: 'metabase', userName: 'analytics', state: 'active', age: 900, xactSeconds: 412 },
      selfApplicationName: 'pgboss'
    })

    const stored = await provoke(boss)

    // Never the holder's SQL text, at any length: warning.data is readable with plain SELECT on this
    // schema, kept for warningRetentionDays and forwarded to logs, while pg_stat_activity.query
    // takes pg_read_all_stats and dies with the backend. state carries the diagnosis instead.
    expect(stored.data).not.toHaveProperty('holderQuery')
    expect(stored.data.holderState).toBe('active')
    expect(JSON.stringify(stored.data)).not.toContain('SELECT')

    expect(stored.data.holderApplicationName).toBe('metabase')
    expect(stored.data.holderUserName).toBe('analytics')
    expect(stored.data.holderTransactionSeconds).toBe(412)
    expect(stored.data.self).toBe(false)
    expect(stored.message).toContain("another application (application_name 'metabase', role analytics, pid 4242) has held a transaction open for 412s")
  })

  it('says so when the holder shares this application_name', async function () {
    // Db sets application_name to 'pgboss' on the pool it owns, so a holder carrying this
    // connection's own value is pg-boss doing it to itself — its own stats aggregate most likely.
    const boss = await withStagedHolder({
      backendHolder: { pid: 4243, applicationName: 'pgboss', userName: 'app', state: 'active', age: 900, xactSeconds: 30 },
      selfApplicationName: 'pgboss'
    })

    const stored = await provoke(boss)

    expect(stored.data.self).toBe(true)
    expect(stored.message).toContain("this application's own connection (application_name 'pgboss'")
  })

  it('will not guess when the holder set no application_name', async function () {
    const boss = await withStagedHolder({
      backendHolder: { pid: 4244, applicationName: '', userName: 'app', state: null, age: 900, xactSeconds: null },
      selfApplicationName: 'pgboss'
    })

    const stored = await provoke(boss)

    expect(stored.data.self).toBe(false)
    // Neither ours nor assertably someone else's, and an unreadable xact_start is said rather than
    // rendered as a number.
    expect(stored.message).toContain('a backend with no application_name (role app, pid 4244)')
    expect(stored.message).toContain('for an unreadable length of time')
  })

  it('reports how many backends this role could not inspect', async function () {
    // pg_stat_activity hands an ordinary role a NULL xact_start for a backend owned by a different
    // role, so those holders can be counted but never named or timed.
    const boss = await withStagedHolder({ backendHolder: null, opaqueBackends: 3 })

    const stored = await provoke(boss)

    // Falls back to the holder class, and says plainly that the picture is partial rather than
    // letting an unnameable holder read as no holder.
    expect(stored.data.opaqueBackends).toBe(3)
    expect(stored.data.holderPid).toBeNull()
    expect(stored.message).toContain('backend holding an open transaction')
    expect(stored.message).toContain('3 backend(s) could not be inspected')
    expect(stored.message).toContain('GRANT pg_read_all_stats')
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

  // A managed provider can revoke a catalog the horizon query reads. The whole statement fails, so
  // the check has to find out which sources this role can still read rather than losing the answer.
  it('drops the sources the role cannot read and keeps the rest', async function () {
    const realDb = await helper.getDb()
    let slotAttempts = 0

    const boss = await startBoss({
      db: {
        async executeSql (sql: string, values: any[]) {
          if (sql.includes('pg_replication_slots')) {
            slotAttempts++
            throw new Error('permission denied for view pg_replication_slots')
          }

          return realDb.executeSql(sql, values)
        }
      }
    })

    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()

      // Second pass is the first one with a failed vacuum behind it, so it is the first to read the
      // horizon: the combined query fails, and the probe loop narrows to the readable sources.
      await churn(boss, 'garbage')
      await boss.supervise()

      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(0)
      // The combined statement plus one probe per revoked source, all in that one pass.
      expect(slotAttempts).toBe(3)

      await churn(boss, 'garbage')
      await boss.supervise()

      const [stored] = await storedWarnings(ctx.schema, 'xmin_horizon')

      expect(stored.data.source).toBe('backends')
      // A partial answer says so, so an empty pg_replication_slots this role never read cannot be
      // mistaken for evidence that no slot is holding the horizon.
      expect(stored.data.unreadableSources).toEqual(['slots', 'slotsCatalog'])

      // Narrowing is remembered: later passes never pay for the revoked sources again.
      await churn(boss, 'garbage')
      await boss.supervise()

      expect(slotAttempts).toBe(3)
    } finally {
      await release()
      await realDb.close()
    }
  })

  it('disables the check and says so when no source is readable', async function () {
    const realDb = await helper.getDb()
    const warnings: Warning[] = []

    const boss = await startBoss({
      db: {
        async executeSql (sql: string, values: any[]) {
          // Every variant of the horizon query carries this column, narrowed or not.
          if (sql.includes('oldestTransactionSeconds')) throw new Error('permission denied for view pg_stat_activity')

          return realDb.executeSql(sql, values)
        }
      }
    })

    boss.on('warning', w => warnings.push(w))

    const release = await holdHorizon()

    try {
      await churn(boss, 'garbage')
      await boss.supervise()
      await churn(boss, 'garbage')
      await boss.supervise()

      // Two more passes with the same stuck garbage. Narrowing found nothing readable and said so;
      // it must not keep re-probing and re-warning every pass thereafter, and it must not hand an
      // empty source list back to a query builder that cannot express one.
      await churn(boss, 'garbage')
      await boss.supervise()
      await churn(boss, 'garbage')
      await boss.supervise()

      const disabled = warnings.filter(w => w.message.includes('xmin_horizon check is disabled'))

      expect(disabled).toHaveLength(1)
      expect((disabled[0].data as { type: string }).type).toBe('xmin_horizon')
      expect((disabled[0].data as { error: string }).error).toContain('permission denied')

      // No holder can be named without a readable source, so the diagnosis is withheld rather than
      // guessed at from the table evidence alone.
      expect(await storedWarnings(ctx.schema, 'xmin_horizon')).toHaveLength(0)
    } finally {
      await release()
      await realDb.close()
    }
  })

  it('rejects a non-boolean setting', async function () {
    const { PgBoss } = await import('../src/index.ts')

    expect(() => new PgBoss({ ...ctx.bossConfig, monitorVacuum: 1_000_000 } as never))
      .toThrow('monitorVacuum must be a boolean')
  })
})
