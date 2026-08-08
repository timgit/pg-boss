/*
 * Interactive console against the seeded demo database.
 *
 *   npm run console                    # connects to a pgboss database on localhost
 *   bun scripts/console.js             # same, direct invocation
 *
 * In the REPL you get:
 *   boss            a started BunBoss instance (await boss.getQueueStats('queue-25'))
 *   sql`...`        tagged-template raw query, returns rows (await sql`select now()`)
 *   sql(text, vals) same, with $1.. params       (await sql('select $1::int', [7]))
 *   db              the underlying Bun SQL client
 *   schema          the bun-boss schema name ('pgboss')
 *
 * Top-level await works. Ctrl-D (or .exit) shuts everything down cleanly.
 */

import repl from 'node:repl'
import { SQL } from 'bun'
import { BunBoss } from '../src/index.ts'

const base = {
  hostname: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  username: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'pgboss'
}
const schema = 'pgboss'

const db = new SQL({ ...base, max: 4 })
const boss = new BunBoss({ ...base, schema, persistQueueStats: true })

// sql`select $1` interpolations → params  OR  sql('select $1', [val]) → rows
function sql (strings, ...values) {
  if (typeof strings === 'string') {
    return db.unsafe(strings, values[0]).then(r => [...r])
  }
  return db(strings, ...values).then(r => [...r])
}

await boss.start()
console.log(`Connected to ${base.database} (schema "${schema}").`)
console.log('Globals: boss, sql, db, schema. Top-level await is on. Ctrl-D to exit.\n')

const r = repl.start({ prompt: 'pgboss> ', useGlobal: true })
Object.assign(r.context, { boss, sql, db, schema, base })

r.on('exit', async () => {
  try { await boss.stop({ graceful: false }) } catch {}
  try { await db.close() } catch {}
  process.exit(0)
})
