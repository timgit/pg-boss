// Index performance analysis for the job-fetch hot path.
//
// Goal: prove (or disprove) with EXPLAIN (ANALYZE, BUFFERS) how the fetch index `job_i5` is
// actually used, then compare candidate index shapes on the same data:
//   1. baseline    - the current job_i5: (name, start_after) INCLUDE (priority, created_on, id)
//   2. no-INCLUDE  - (name, start_after)                      -- is the INCLUDE payload dead weight?
//   3. priority    - (name, priority DESC, created_on, id)    -- does a sort-key index kill the Sort node?
//
// The fetch's inner `next` CTE is what selects rows via job_i5, so we analyze that candidate
// SELECT in isolation (the outer UPDATE only joins by primary key). We also dump the full
// faithful fetchNextJob() statement once on baseline so the real plan is on record.
//
// Run:  npx tsx examples/index-perf/index.ts
// Knobs (env): COMPLETED, ELIGIBLE, FUTURE, LIMITS (csv), KEEP=1 to leave the schema for inspection.

import { PgBoss } from '../../src/index.ts'
import * as plans from '../../src/plans.ts'
import * as helper from '../../test/testHelper.ts'

const SCHEMA = process.env.SCHEMA || 'idxperf'
const QUEUE = 'perfqueue'
const TABLE = 'job_common' // default (non-partitioned) queues all share this partition

// Data shape: a large completed backlog (excluded from the partial index) plus a working set of
// eligible `created` jobs and some future-scheduled ones (present in the index, filtered by start_after).
const COMPLETED = Number(process.env.COMPLETED ?? 500_000)
const ELIGIBLE = Number(process.env.ELIGIBLE ?? 50_000)
const FUTURE = Number(process.env.FUTURE ?? 5_000)
const LIMITS = (process.env.LIMITS || '1,100').split(',').map(n => Number(n.trim()))

type Db = Awaited<ReturnType<typeof helper.getDb>>

async function main () {
  await helper.init()
  await helper.dropSchema(SCHEMA)

  const config = helper.getConfig({ schema: SCHEMA })
  const boss = new PgBoss({ ...config, supervise: false, schedule: false })
  boss.on('error', console.error)
  await boss.start()
  await boss.createQueue(QUEUE)

  const db = await helper.getDb()
  try {
    await seed(db)

    // The fetch index as the migrations built it on job_common; discover its real name so we can
    // swap variants in/out without guessing the partition-suffixed identifier.
    const fetchIndex = await findFetchIndex(db)
    console.log(`\nfetch index on ${SCHEMA}.${TABLE}: ${fetchIndex.name}\n  ${fetchIndex.def}\n`)

    // Before mangling indexes for the variant comparison, verify the migration-built job_i5 is
    // actually reached by every dynamic shape the production fetchNextJob() can emit.
    await verifyShapes(db, fetchIndex.name)

    // Record the real, full fetchNextJob() plan once (UPDATE ... RETURNING, rolled back).
    console.log('='.repeat(90))
    console.log('FULL fetchNextJob() statement (baseline job_i5), limit=1')
    console.log('='.repeat(90))
    const full = plans.fetchNextJob({
      schema: SCHEMA,
      table: TABLE,
      name: QUEUE,
      policy: 'standard',
      limit: 1,
      includeMetadata: true,
      priority: true,
      orderByCreatedOn: true,
      ignoreSingletons: null
    } as any)
    await explain(db, 'full fetch (limit=1)', full.text, full.values as unknown[])

    // Then the isolated candidate SELECT across index variants and limits.
    const startAfterIdx = (n: string) => `CREATE INDEX ${n} ON ${SCHEMA}.${TABLE} (name, start_after) WHERE state < 'active' AND NOT blocked`
    const priorityIdx = (n: string) => `CREATE INDEX ${n} ON ${SCHEMA}.${TABLE} (name, priority DESC, created_on, id) WHERE state < 'active' AND NOT blocked`
    const variants: Array<{ label: string, ddl: Array<(n: string) => string> }> = [
      { label: 'baseline  (name, start_after) INCLUDE (priority, created_on, id)', ddl: [n => `CREATE INDEX ${n} ON ${SCHEMA}.${TABLE} (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active' AND NOT blocked`] },
      { label: 'no-INCLUDE (name, start_after)', ddl: [startAfterIdx] },
      { label: 'priority  (name, priority DESC, created_on, id)', ddl: [priorityIdx] },
      { label: 'both      start_after + priority (planner chooses)', ddl: [startAfterIdx, priorityIdx] }
    ]

    const summary: Row[] = []
    for (const v of variants) {
      await useOnlyIndex(db, v.ddl)
      for (const limit of LIMITS) {
        const sql = candidateSql(limit)
        console.log('\n' + '-'.repeat(90))
        console.log(`VARIANT: ${v.label}   |   limit=${limit}`)
        console.log('-'.repeat(90))
        const plan = await explain(db, `${v.label} limit=${limit}`, sql, [])
        summary.push({ variant: v.label, limit, ...digest(plan) })
      }
    }

    printSummary(summary)
  } finally {
    await db.close()
    await boss.stop({ wait: true })
    if (!process.env.KEEP) await helper.dropSchema(SCHEMA)
    else console.log(`\nKEEP set: schema ${SCHEMA} left intact for inspection.`)
  }
}

// The inner `next` CTE for the common (no singleton/group/priority-bounds) path: this is the exact
// shape that uses the fetch index and incurs (or avoids) the ORDER BY sort.
function candidateSql (limit: number): string {
  return `
    SELECT j.id
    FROM ${SCHEMA}.${TABLE} j
    WHERE j.name = '${QUEUE}'
      AND j.state < 'active'
      AND NOT j.blocked
      AND j.start_after <= now()
    ORDER BY j.priority desc, j.created_on, j.id
    LIMIT ${limit}
    FOR UPDATE OF j SKIP LOCKED`
}

async function seed (db: Db) {
  console.log(`seeding: ${COMPLETED} completed + ${ELIGIBLE} eligible + ${FUTURE} future jobs ...`)
  // Completed backlog — NOT in the partial index (state >= 'active').
  await db.executeSql(`
    INSERT INTO ${SCHEMA}.${TABLE} (name, state, priority, completed_on)
    SELECT '${QUEUE}', 'completed', 0, now()
    FROM generate_series(1, ${COMPLETED})`)
  // Eligible created jobs — in the index, due now. ~1% carry a non-zero priority.
  await db.executeSql(`
    INSERT INTO ${SCHEMA}.${TABLE} (name, state, priority, start_after, created_on)
    SELECT '${QUEUE}', 'created',
      CASE WHEN g % 100 = 0 THEN (g % 9) + 1 ELSE 0 END,
      now() - ((g % 3600) || ' seconds')::interval,
      now() - ((g % 3600) || ' seconds')::interval
    FROM generate_series(1, ${ELIGIBLE}) g`)
  // Future-scheduled created jobs — in the index, filtered out by start_after <= now().
  // FUTURE_HI gives them a high priority to model the priority index's worst case: many
  // not-yet-due jobs ranked ahead of the due ones, which a priority-keyed walk must filter past.
  const futurePriority = process.env.FUTURE_HI ? 9 : 0
  await db.executeSql(`
    INSERT INTO ${SCHEMA}.${TABLE} (name, state, priority, start_after, created_on)
    SELECT '${QUEUE}', 'created', ${futurePriority}, now() + interval '1 day', now()
    FROM generate_series(1, ${FUTURE})`)
  await db.executeSql(`ANALYZE ${SCHEMA}.${TABLE}`)
  console.log('seeded + ANALYZEd.')
}

async function findFetchIndex (db: Db): Promise<{ name: string, def: string }> {
  const res = await db.executeSql(
    'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexdef LIKE \'%start_after%\'',
    [SCHEMA, TABLE]
  )
  const row = res.rows[0]
  return { name: row.indexname, def: row.indexdef }
}

// Drop every fetch-candidate index on job_common (the job_i5 family — any index mentioning
// start_after or priority in its leading key), then create just `ddl` as job_i5_perf. This forces
// the planner to choose between that one index and a sequential scan, so usage is unambiguous.
async function useOnlyIndex (db: Db, ddls: Array<(name: string) => string>) {
  const res = await db.executeSql(
    'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
    [SCHEMA, TABLE]
  )
  for (const r of res.rows) {
    // Drop anything that could serve the fetch (start_after- or priority-keyed), but never the PK.
    if (/start_after|priority/.test(r.indexdef) && !/_pkey/.test(r.indexname)) {
      await db.executeSql(`DROP INDEX ${SCHEMA}.${r.indexname}`)
    }
  }
  for (let i = 0; i < ddls.length; i++) {
    await db.executeSql(ddls[i](`job_i5_perf_${i}`))
  }
  await db.executeSql(`ANALYZE ${SCHEMA}.${TABLE}`)
}

async function explain (db: Db, _label: string, sql: string, values: unknown[], quiet = false): Promise<string> {
  // ANALYZE executes the statement; wrap in a transaction and roll back so the UPDATE/locks vanish.
  await db.executeSql('BEGIN')
  let text = ''
  try {
    const res = await db.executeSql(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT) ${sql}`, values)
    text = res.rows.map((r: any) => r['QUERY PLAN']).join('\n')
    if (!quiet) console.log(text)
  } finally {
    await db.executeSql('ROLLBACK')
  }
  return text
}

// Isolate the `CTE next` subtree of an EXPLAIN plan — the candidate-selection step that uses the
// fetch index — so we don't mistake the pkey join (or the groupConcurrency active_group_counts CTE)
// for the fetch scan. CTEs print at 2-space indent; the block runs until the next CTE / main node.
function nextCteBlock (plan: string): string {
  const start = plan.indexOf('CTE next')
  if (start < 0) return plan
  const rel = plan.slice(start + 8).search(/\n {2}(CTE |-> )/)
  return rel < 0 ? plan.slice(start) : plan.slice(start, start + 8 + rel)
}

// Drive the REAL fetchNextJob() across the dynamic option combinations and confirm each still
// reaches job_i5 via the index (not a Seq Scan). This guards against a dynamic WHERE/ORDER BY shape
// silently regressing the hot path to a table scan. Runs against the migration-built index.
async function verifyShapes (db: Db, fetchIndexName: string) {
  console.log('\n' + '='.repeat(90))
  console.log(`SHAPE MATRIX — does the real fetchNextJob() still reach ${fetchIndexName} for every dynamic condition?`)
  console.log('='.repeat(90))
  console.log(['shape', 'next-CTE access', `uses ${fetchIndexName}?`, 'sort?'].join('\t'))
  const base = {
    schema: SCHEMA,
    table: TABLE,
    name: QUEUE,
    policy: 'standard',
    limit: 1,
    includeMetadata: true,
    priority: true,
    orderByCreatedOn: true,
    ignoreSingletons: null
  }
  const shapes: Array<{ label: string, opts: Record<string, unknown> }> = [
    { label: 'base                ', opts: {} },
    { label: 'ignoreStartAfter    ', opts: { ignoreStartAfter: true } },
    { label: 'ignoreSingletons    ', opts: { ignoreSingletons: ['k1', 'k2'] } },
    { label: 'ignoreGroups        ', opts: { ignoreGroups: ['g1', 'g2'] } },
    { label: 'min/maxPriority     ', opts: { minPriority: 1, maxPriority: 9 } },
    { label: 'groupConcurrency    ', opts: { groupConcurrency: 5 } },
    { label: 'priority+order OFF  ', opts: { priority: false, orderByCreatedOn: false } },
    { label: 'batch limit=100     ', opts: { limit: 100 } }
  ]
  for (const s of shapes) {
    const q = plans.fetchNextJob({ ...base, ...s.opts } as any)
    const plan = await explain(db, s.label, q.text, q.values as unknown[], true)
    const block = nextCteBlock(plan)
    const seqOnFetch = new RegExp(`Seq Scan on ${SCHEMA}\\.${TABLE}\\b`).test(block)
    const usesIdx = block.includes(fetchIndexName)
    const usesPkey = /_pkey/.test(block)
    // The only real regression is a Seq Scan. Using job_i5 (Bitmap/Index) is the target; falling to
    // the PK (name, id) is an acceptable index plan the planner picks when ORDER BY is id-only.
    const access = seqOnFetch
      ? 'SEQ SCAN ⚠️'
      : usesIdx
        ? (/Bitmap/.test(block) ? 'Bitmap(job_i5)' : 'Index Scan(job_i5)')
        : usesPkey ? 'Index Scan(pkey)' : 'other ⚠️'
    const sort = /\bSort\b/.test(block)
    console.log([s.label, access, usesIdx ? 'yes' : (usesPkey ? 'pkey' : 'NO ⚠️'), sort ? 'SORT' : 'no-sort'].join('\t'))
  }
}

interface Row { variant: string, limit: number, scan: string, sort: boolean, ms: number }

function digest (plan: string): { scan: string, sort: boolean, ms: number } {
  const scan = /Seq Scan/.test(plan)
    ? 'Seq Scan'
    : /Bitmap/.test(plan)
      ? 'Bitmap'
      : /Index Only Scan/.test(plan)
        ? 'Index Only Scan'
        : /Index Scan/.test(plan) ? 'Index Scan' : 'other'
  const sort = /\bSort\b/.test(plan)
  const m = plan.match(/Execution Time: ([\d.]+) ms/)
  return { scan, sort, ms: m ? Number(m[1]) : NaN }
}

function printSummary (rows: Row[]) {
  console.log('\n' + '='.repeat(90))
  console.log('SUMMARY')
  console.log('='.repeat(90))
  console.log(['variant', 'limit', 'scan', 'sort?', 'exec ms'].join('\t'))
  for (const r of rows) {
    console.log([r.variant.slice(0, 48), r.limit, r.scan, r.sort ? 'SORT' : 'no-sort', r.ms.toFixed(2)].join('\t'))
  }
}

main().catch(err => { console.error(err); process.exit(1) })
