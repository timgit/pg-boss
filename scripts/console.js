/*
 * Interactive console against the seeded demo database.
 *
 *   npm run console                    # connects to a pgboss database on localhost
 *   npx tsx scripts/console.js         # same, direct invocation
 *
 * In the REPL you get:
 *   boss            a started PgBoss instance (await boss.getQueueStats('queue-25'))
 *   sql`...`        tagged-template raw query, returns rows (await sql`select now()`)
 *   sql(text, vals) same, with $1.. params       (await sql('select $1::int', [7]))
 *   pool            the underlying pg Pool
 *   schema          the pg-boss schema name ('pgboss')
 *
 * Top-level await works. Ctrl-D (or .exit) shuts everything down cleanly.
 */

import repl from 'node:repl'
import pg from 'pg'
import { PgBoss } from '../src/index.ts'

const base = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'pgboss'
}
const schema = 'pgboss'

const pool = new pg.Pool({ ...base, max: 4 })
const boss = new PgBoss({ ...base, schema, persistQueueStats: true })

// sql`select $1` interpolations → $1..$n params  OR  sql('select $1', [val]) → rows
function sql (strings, ...values) {
  if (typeof strings === 'string') {
    return pool.query(strings, values[0]).then(r => r.rows)
  }
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '')
  return pool.query(text, values).then(r => r.rows)
}

await boss.start()
console.log(`Connected to ${base.database} (schema "${schema}").`)
console.log('Globals: boss, sql, pool, schema. Top-level await is on. Ctrl-D to exit.\n')

const r = repl.start({ prompt: 'pgboss> ', useGlobal: true })
Object.assign(r.context, { boss, sql, pool, schema, base })

r.on('exit', async () => {
  try { await boss.stop({ graceful: false }) } catch {}
  try { await pool.end() } catch {}
  process.exit(0)
})
