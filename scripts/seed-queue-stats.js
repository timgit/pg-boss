/*
 * Seed a fresh database with a week of queue_stats history for 50 queues so the
 * new persistQueueStats / getQueueStats feature can be exercised, and so daily
 * partition pruning is observable via EXPLAIN.
 *
 *   npm run seed                       # or: npx tsx scripts/seed-queue-stats.js
 *
 * Runs against the live TypeScript source (src/) via tsx — no build step needed.
 *
 * Env overrides (defaults match test/config.json):
 *   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres
 *   SEED_DB=pgboss_stats_demo   target database (dropped + recreated)
 *   SEED_QUEUES=50              number of queues
 *   SEED_DAYS=7                 days of history
 *   SEED_INTERVAL_SEC=60        seconds between snapshots; defaults to pg-boss's
 *                               own monitorIntervalSeconds default (attorney.ts)
 */

import pg from 'pg'
import { PgBoss } from '../src/index.ts'

const { Client, Pool } = pg

const HOST = process.env.PGHOST || '127.0.0.1'
const PORT = Number(process.env.PGPORT || 5432)
const USER = process.env.PGUSER || 'postgres'
const PASSWORD = process.env.PGPASSWORD || 'postgres'
const DB = process.env.SEED_DB || 'pgboss_stats_demo'

const QUEUES = Number(process.env.SEED_QUEUES || 50)
const DAYS = Number(process.env.SEED_DAYS || 7)
// pg-boss captures a stats snapshot every monitorIntervalSeconds, which defaults
// to 60s (src/attorney.ts: `config.monitorIntervalSeconds || 60`). Match it.
const INTERVAL_SEC = Number(process.env.SEED_INTERVAL_SEC || 60)
const SCHEMA = 'pgboss'

const base = { host: HOST, port: PORT, user: USER, password: PASSWORD }

async function recreateDatabase () {
  const admin = new Client({ ...base, database: 'postgres' })
  await admin.connect()
  // terminate any stragglers, then drop + create a clean db
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB])
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`)
  await admin.query(`CREATE DATABASE ${DB}`)
  await admin.end()
  console.log(`• recreated database "${DB}"`)
}

async function installSchema () {
  // Let pg-boss build schema v35 exactly as it would in production, with the
  // queue_stats history table + today/tomorrow partitions.
  const boss = new PgBoss({
    ...base,
    database: DB,
    schema: SCHEMA,
    persistQueueStats: true,
    queueStatRetentionDays: DAYS
  })
  await boss.start()

  const names = Array.from({ length: QUEUES }, (_, i) => `queue-${String(i + 1).padStart(2, '0')}`)
  for (const name of names) await boss.createQueue(name)
  await boss.stop({ graceful: false })
  console.log(`• installed schema v35 and created ${QUEUES} queues`)
  return names
}

async function seed (names) {
  const pool = new Pool({ ...base, database: DB, max: 4 })

  // 1) Create the historical daily partitions. pg-boss's ensureQueueStatsPartitions
  //    only makes today + tomorrow; we need one partition per past day so the
  //    backdated rows route correctly and pruning has something to prune.
  await pool.query(`
    DO $$
    DECLARE d date; part text;
    BEGIN
      FOR i IN 0..${DAYS} LOOP
        d := (now() AT TIME ZONE 'UTC')::date - i;
        part := 'queue_stats_' || to_char(d, 'YYYYMMDD');
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${SCHEMA}' AND c.relname = part
        ) THEN
          EXECUTE format(
            'CREATE TABLE ${SCHEMA}.%I PARTITION OF ${SCHEMA}.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00');
        END IF;
      END LOOP;
    END $$;
  `)

  // 2) Generate the series entirely in SQL. One row per queue per snapshot.
  //    Counts follow a per-queue base load shaped by a diurnal sine wave plus a
  //    little jitter, so busy and idle queues look distinct on a chart.
  //      - queue index i drives base throughput (queue-50 ~10x queue-01)
  //      - diurnal factor peaks mid-afternoon UTC, dips overnight
  //      - failed_count is a rare spike; deferred trails scheduled work
  const sql = `
    INSERT INTO ${SCHEMA}.queue_stats
      (name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count, captured_on)
    SELECT
      q.name,
      d.deferred, d.queued, d.ready, d.active, d.failed,
      d.deferred + d.queued + d.ready + d.active + d.failed + d.completed AS total_count,
      ts
    FROM generate_series(
           date_trunc('minute', now()) - interval '${DAYS} days',
           date_trunc('minute', now()),
           interval '${INTERVAL_SEC} seconds') AS ts
    CROSS JOIN unnest($1::text[]) WITH ORDINALITY AS q(name, i)
    CROSS JOIN LATERAL (
      SELECT
        -- diurnal load: 0..1, peaks ~15:00 UTC
        (0.45 + 0.55 * (0.5 + 0.5 * sin((extract(hour from ts) - 9) / 24.0 * 2 * pi())))
          * (2 + q.i * 1.2)                         AS load
    ) l
    CROSS JOIN LATERAL (
      SELECT
        greatest(0, round(l.load * (0.8 + 0.4 * (extract(epoch from ts)::bigint % 7) / 7.0)))::int  AS queued,
        greatest(0, round(l.load * 0.25))::int                                                       AS active,
        greatest(0, round(l.load * 0.15))::int                                                       AS ready,
        greatest(0, round(l.load * 0.10 * ((extract(epoch from ts)::bigint % 5)))) ::int             AS deferred,
        (CASE WHEN (extract(epoch from ts)::bigint / 60) % 47 = q.i % 47 THEN (1 + q.i % 4) ELSE 0 END)::int AS failed,
        -- completed grows steadily across the week to give total_count a trend
        round(l.load * 5 * (1 + extract(epoch from (ts - (now() - interval '${DAYS} days'))) / 86400.0))::int AS completed
    ) d;
  `
  const t0 = Date.now()
  await pool.query(sql, [names])
  const ins = Date.now() - t0

  // 3) Mirror the latest snapshot per queue into the queue cache columns so the
  //    live getQueueStats() cache + dashboard reflect the seeded "now".
  await pool.query(`
    UPDATE ${SCHEMA}.queue q
    SET deferred_count = s.deferred_count, queued_count = s.queued_count,
        ready_count = s.ready_count, active_count = s.active_count,
        failed_count = s.failed_count, total_count = s.total_count,
        monitor_on = s.captured_on
    FROM (
      SELECT DISTINCT ON (name) name, deferred_count, queued_count, ready_count,
             active_count, failed_count, total_count, captured_on
      FROM ${SCHEMA}.queue_stats
      ORDER BY name, captured_on DESC
    ) s
    WHERE s.name = q.name;
  `)

  const { rows: [{ count, parts }] } = await pool.query(`
    SELECT
      (SELECT count(*) FROM ${SCHEMA}.queue_stats) AS count,
      (SELECT count(*) FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = '${SCHEMA}' AND p.relname = 'queue_stats') AS parts
  `)
  console.log(`• inserted ${Number(count).toLocaleString()} stat rows across ${parts} daily partitions in ${ins} ms`)

  // 4) Demonstrate partition pruning: a single-day window should touch one
  //    partition, the full week should touch them all.
  const day = await explainPartitions(pool,
    `SELECT count(*) FROM ${SCHEMA}.queue_stats
     WHERE name = 'queue-25'
       AND captured_on >= date_trunc('day', now() - interval '3 days')
       AND captured_on <  date_trunc('day', now() - interval '2 days')`)
  const week = await explainPartitions(pool,
    `SELECT count(*) FROM ${SCHEMA}.queue_stats
     WHERE name = 'queue-25'
       AND captured_on >= now() - interval '${DAYS} days'`)
  console.log(`• partition pruning: bounded 1-day window scans ${day.length} partition(s) [${day.join(', ')}]`)
  console.log(`                     ${DAYS}-day window scans ${week.length} partition(s) — the rest are pruned`)

  await pool.end()
}

// Parse EXPLAIN output and collect which queue_stats_* partitions the planner kept.
async function explainPartitions (pool, query) {
  const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${query}`)
  const found = new Set()
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node['Relation Name'] === 'string' && node['Relation Name'].startsWith('queue_stats_')) {
      found.add(node['Relation Name'].replace('queue_stats_', ''))
    }
    Object.values(node).forEach(walk)
  }
  walk(rows[0]['QUERY PLAN'])
  return [...found].sort()
}

async function demo () {
  // Show the public API returning real history: raw + an hourly avg rollup.
  const boss = new PgBoss({ ...base, database: DB, schema: SCHEMA, persistQueueStats: true })
  await boss.start()
  const queue = 'queue-25'
  const raw = await boss.getQueueStats(queue, { limit: 3 })
  const hourly = await boss.getQueueStats(queue, {
    from: new Date(Date.now() - 24 * 3600 * 1000),
    bucketSeconds: 3600,
    aggregate: 'avg'
  })
  await boss.stop({ graceful: false })
  console.log(`\n• getQueueStats('${queue}') newest 3 raw snapshots:`)
  for (const r of raw) {
    console.log(`    ${r.capturedOn.toISOString()}  queued=${r.queuedCount} active=${r.activeCount} total=${r.totalCount}`)
  }
  console.log(`• getQueueStats('${queue}', { bucketSeconds: 3600, aggregate: 'avg' }) last 24h → ${hourly.length} hourly points`)
}

async function main () {
  console.log(`Seeding ${QUEUES} queues × ${DAYS} days @ ${INTERVAL_SEC}s into ${DB}\n`)
  await recreateDatabase()
  const names = await installSchema()
  await seed(names)
  await demo()
  console.log('\nDone. Connect with:')
  console.log(`  psql postgresql://${USER}@${HOST}:${PORT}/${DB}`)
  console.log('Inspect partitions:')
  console.log(`  \\d+ ${SCHEMA}.queue_stats`)
}

main().catch(err => { console.error(err); process.exit(1) })
