// Probes the Bun.SQL sqlite driver behaviors the fromBunSqlite adapter depends on. Run it when
// changing the adapter or moving to a new Bun toolchain: REQUIRED rows must hold (exit 1 when
// violated); KNOWN-BUG rows document upstream behavior the adapter works around, and a change
// there means a workaround may be removable — reported, not fatal.
//
// Usage: bun scripts/spike-bun-sqlite.ts

import { SQL } from 'bun'

type Check = {
  name: string
  kind: 'required' | 'known-bug'
  run: (sql: InstanceType<typeof SQL>) => Promise<{ pass: boolean, detail: string }>
}

const checks: Check[] = [
  {
    name: '$N positional binding via unsafe(), including repeated $1',
    kind: 'required',
    run: async (sql) => {
      const rows = await sql.unsafe('SELECT $1 as a, $2 as b, $1 as c', [7, 'x'])
      const pass = rows?.[0]?.a === 7 && rows?.[0]?.b === 'x' && rows?.[0]?.c === 7
      return { pass, detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'single-statement RETURNING yields rows',
    kind: 'required',
    run: async (sql) => {
      await sql.unsafe('CREATE TABLE r1 (id INTEGER)')
      const rows = await sql.unsafe('INSERT INTO r1 VALUES ($1) RETURNING id', [42])
      return { pass: rows?.[0]?.id === 42, detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'quoted dotted identifier "pgboss.job" as a plain table name',
    kind: 'required',
    run: async (sql) => {
      await sql.unsafe('CREATE TABLE "spike.job" (id TEXT)')
      await sql.unsafe('INSERT INTO "spike.job" VALUES ($1)', ['a'])
      const rows = await sql.unsafe('UPDATE "spike.job" SET id = $1 RETURNING id', ['b'])
      return { pass: rows?.[0]?.id === 'b', detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'constraint errors carry the exact SQLITE_CONSTRAINT_* extended codes on err.code',
    kind: 'required',
    run: async (sql) => {
      // Exact extended codes, not the bare SQLITE_CONSTRAINT class: the adapter's SQLSTATE map
      // keys on them, so a toolchain emitting the bare class would miss every entry.
      await sql.unsafe('CREATE TABLE u1 (k TEXT PRIMARY KEY, v TEXT)')
      await sql.unsafe('CREATE UNIQUE INDEX u1_v ON u1 (v)')
      await sql.unsafe('INSERT INTO u1 VALUES ($1, $2)', ['x', 'v1'])
      const pk: any = await sql.unsafe('INSERT INTO u1 VALUES ($1, $2)', ['x', 'v2']).then(() => null, e => e)
      const uq: any = await sql.unsafe('INSERT INTO u1 VALUES ($1, $2)', ['y', 'v1']).then(() => null, e => e)
      const pass = pk?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' && uq?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      return { pass, detail: JSON.stringify({ pk: pk?.code, unique: uq?.code }) }
    }
  },
  {
    name: 'FK violations carry SQLITE_CONSTRAINT_FOREIGNKEY and a "foreign key" message with foreign_keys ON',
    kind: 'required',
    run: async (sql) => {
      // Both the exact code (mapped to 23503) and the message shape (timekeeper's case-insensitive
      // fallback) are load-bearing for schedule-to-missing-queue translation.
      await sql.unsafe('PRAGMA foreign_keys = ON')
      await sql.unsafe('CREATE TABLE fkp (id TEXT PRIMARY KEY)')
      await sql.unsafe('CREATE TABLE fkc (p TEXT REFERENCES fkp (id))')
      const err: any = await sql.unsafe('INSERT INTO fkc VALUES ($1)', ['missing']).then(() => null, e => e)
      const pass = err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' && /foreign key/i.test(err?.message ?? '')
      return { pass, detail: JSON.stringify({ code: err?.code, message: err?.message }) }
    }
  },
  {
    name: 'anonymous ? placeholders bind strictly positionally',
    kind: 'required',
    run: async (sql) => {
      // The only placeholder form the adapter emits after rewriting $N — if this breaks while $N
      // still works, the $N checks alone would green-light a broken toolchain.
      const rows = await sql.unsafe('SELECT ? as a, ? as b, ? as c', [7, 'x', 9])
      const pass = rows?.[0]?.a === 7 && rows?.[0]?.b === 'x' && rows?.[0]?.c === 9
      return { pass, detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'statements share one logical connection: BEGIN via unsafe() governs later unsafe() calls',
    kind: 'required',
    run: async (sql) => {
      // withTransaction issues BEGIN/statements/COMMIT as separate unsafe() calls and the
      // serialization mutex assumes every statement lands inside the open transaction.
      await sql.unsafe('CREATE TABLE tx1 (id INTEGER)')
      await sql.unsafe('BEGIN IMMEDIATE')
      await sql.unsafe('INSERT INTO tx1 VALUES (1)')
      const inside = await sql.unsafe('SELECT count(*) as n FROM tx1')
      await sql.unsafe('ROLLBACK')
      const after = await sql.unsafe('SELECT count(*) as n FROM tx1')
      const pass = inside?.[0]?.n === 1 && after?.[0]?.n === 0
      return { pass, detail: JSON.stringify({ inside: inside?.[0]?.n, after: after?.[0]?.n }) }
    }
  },
  {
    name: 'math functions and aggregate ORDER BY: ceil(), json_group_array(v ORDER BY ord)',
    kind: 'required',
    run: async (sql) => {
      // ceil() needs the math-functions compile flag; aggregate ORDER BY needs SQLite >= 3.44 —
      // both are used by the queue-stats builders.
      const a = await sql.unsafe('SELECT ceil(1.2) as c')
      const b = await sql.unsafe('WITH t(v, ord) AS (VALUES (10, 2), (20, 1)) SELECT json_group_array(v ORDER BY ord) as arr FROM t')
      const pass = a?.[0]?.c === 2 && b?.[0]?.arr === '[20,10]'
      return { pass, detail: JSON.stringify({ a, b }) }
    }
  },
  {
    name: 'modern SQL surface: UPDATE...FROM, upsert excluded, window, FILTER, MATERIALIZED CTE, json_each($1), strftime %f, unixepoch subsec',
    kind: 'required',
    run: async (sql) => {
      const a = await sql.unsafe('SELECT value FROM json_each($1)', ['["a","b"]'])
      const b = await sql.unsafe("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', unixepoch('subsec') + 60, 'unixepoch') as ts")
      const c = await sql.unsafe('WITH c AS MATERIALIZED (SELECT 1 x UNION ALL SELECT 2) SELECT count(*) FILTER (WHERE x > 1) as f, row_number() OVER (ORDER BY x) as r FROM c LIMIT 1')
      await sql.unsafe('CREATE TABLE up1 (k TEXT PRIMARY KEY, n INTEGER)')
      await sql.unsafe("INSERT INTO up1 VALUES ('a', 1)")
      const d = await sql.unsafe("INSERT INTO up1 VALUES ('a', 2) ON CONFLICT (k) DO UPDATE SET n = excluded.n RETURNING n")
      const pass = a?.length === 2 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b?.[0]?.ts) &&
        c?.[0]?.f === 1 && d?.[0]?.n === 2
      return { pass, detail: JSON.stringify({ a, b, c, d }) }
    }
  },
  {
    name: 'SELECT 1/0 returns NULL instead of raising (div-zero signals are silent)',
    kind: 'required',
    run: async (sql) => {
      const rows = await sql.unsafe('SELECT 1/0 as d').then(r => r, e => e)
      return { pass: Array.isArray(rows) && rows[0]?.d === null, detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'multi-statement string through unsafe() loses result rows (and may drop statements)',
    kind: 'known-bug',
    run: async (sql) => {
      await sql.unsafe('CREATE TABLE m1 (id INTEGER)')
      const result = await sql.unsafe('INSERT INTO m1 VALUES (1); SELECT 99 as x; INSERT INTO m1 VALUES (2)').then(r => r, e => e)
      const rows = await sql.unsafe('SELECT count(*) as n FROM m1')
      const rowsLost = !Array.isArray(result) || !result.some((r: any) => r?.x === 99)
      const statementDropped = rows?.[0]?.n !== 2
      return { pass: rowsLost || statementDropped, detail: `result=${JSON.stringify(result)}, ${rows?.[0]?.n} of 2 inserts executed` }
    }
  },
  {
    name: 'array values bind to $N by order of first appearance, not by number',
    kind: 'known-bug',
    run: async (sql) => {
      const rows = await sql.unsafe('SELECT $2 as second, $1 as first', ['A', 'B']).then(r => r, e => `threw: ${e.message}`)
      const pass = !Array.isArray(rows) || (rows[0]?.second === 'A' && rows[0]?.first === 'B')
      return { pass, detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'reserve() unsupported on the sqlite adapter',
    kind: 'known-bug',
    run: async (sql) => {
      const err: any = await (sql as any).reserve().then(() => null, (e: any) => e)
      return { pass: err !== null, detail: err?.message ?? 'reserve() succeeded' }
    }
  },
  {
    name: 'Date parameter binds as NULL',
    kind: 'known-bug',
    run: async (sql) => {
      const rows = await sql.unsafe('SELECT $1 as d', [new Date()]).then(r => r, e => `threw: ${e.message}`)
      return { pass: !Array.isArray(rows) || rows[0]?.d === null, detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'double-quote inside a single-quoted literal breaks SELECT (returns no rows)',
    kind: 'known-bug',
    run: async (sql) => {
      const rows = await sql.unsafe('SELECT \'a"b\' as v').then(r => r, e => `threw: ${e.message}`)
      return { pass: !Array.isArray(rows) || rows.length === 0, detail: JSON.stringify(rows) }
    }
  },
  {
    name: 'alias-qualified columns in RETURNING are rejected',
    kind: 'known-bug',
    run: async (sql) => {
      await sql.unsafe('CREATE TABLE al1 (id INTEGER)')
      await sql.unsafe('INSERT INTO al1 VALUES (1)')
      const err: any = await sql.unsafe('UPDATE al1 AS j SET id = 2 WHERE j.id = 1 RETURNING j.id').then(() => null, (e: any) => e)
      return { pass: err !== null, detail: err?.message ?? 'alias-qualified RETURNING succeeded' }
    }
  }
]

const sql = new SQL('sqlite://:memory:')
const version = await sql.unsafe('SELECT sqlite_version() as v')
console.log(`Bun ${Bun.version}, SQLite ${version?.[0]?.v}\n`)

let failed = 0

for (const check of checks) {
  let pass = false
  let detail = ''

  try {
    ({ pass, detail } = await check.run(sql))
  } catch (err: any) {
    detail = `check threw: ${err.message}`
  }

  if (check.kind === 'required') {
    console.log(`${pass ? 'ok  ' : 'FAIL'} [required]  ${check.name}`)
    if (!pass) {
      failed++
      console.log(`      ${detail}`)
    }
  } else {
    console.log(`${pass ? 'ok  ' : 'NOTE'} [known-bug] ${check.name}`)
    if (!pass) {
      console.log(`      behavior changed — the adapter workaround may be removable: ${detail}`)
    }
  }
}

await sql.close()

if (failed) {
  console.error(`\n${failed} required behavior(s) violated — fromBunSqlite cannot work on this toolchain`)
  process.exit(1)
}

console.log('\nall required behaviors hold')
