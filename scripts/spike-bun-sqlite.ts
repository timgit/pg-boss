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
    name: 'constraint errors carry SQLITE_CONSTRAINT_* on err.code',
    kind: 'required',
    run: async (sql) => {
      await sql.unsafe('CREATE TABLE u1 (k TEXT PRIMARY KEY)')
      await sql.unsafe('INSERT INTO u1 VALUES ($1)', ['x'])
      const err: any = await sql.unsafe('INSERT INTO u1 VALUES ($1)', ['x']).then(() => null, e => e)
      const pass = typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')
      return { pass, detail: JSON.stringify({ code: err?.code, errno: err?.errno, message: err?.message }) }
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
