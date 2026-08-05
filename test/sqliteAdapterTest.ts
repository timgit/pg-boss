import { describe, it, expect } from 'vitest'
import { fromBunSqlite, type BunSqliteLike } from '../src/adapters/index.ts'
import { rewritePlaceholders, splitStatements } from '../src/adapters/sqlite.ts'
import { delay } from '../src/tools.ts'

type Call = { text: string, values?: unknown[] }

function sqlResult (rows: any[]): any {
  return Object.assign(rows, { count: rows.length, command: 'SELECT' })
}

function createFakeSqlite (options: {
  result?: any
  errorOn?: (text: string) => unknown
  delayMs?: number
} = {}) {
  const calls: Call[] = []

  const sql: BunSqliteLike = {
    async unsafe (text: string, values?: unknown[]) {
      calls.push({ text, values })

      if (options.delayMs) {
        await delay(options.delayMs)
      }

      const err = options.errorOn?.(text)
      if (err) throw err

      return options.result ?? sqlResult([{ id: '1' }])
    }
  }

  return { sql, calls }
}

// Statements the fake receives after the adapter's one-time PRAGMA init.
function afterInit (calls: Call[]): Call[] {
  return calls.filter(c => !c.text.startsWith('PRAGMA'))
}

describe('sqlite adapter', () => {
  describe('rewritePlaceholders', () => {
    it('rewrites $N to anonymous placeholders in appearance order', () => {
      const { query, params } = rewritePlaceholders('SELECT $2 as b, $1 as a', ['A', 'B'])
      expect(query).toBe('SELECT ? as b, ? as a')
      expect(params).toEqual(['B', 'A'])
    })

    it('expands repeated references into duplicated values', () => {
      const { query, params } = rewritePlaceholders('SELECT $1, $2, $1', ['A', 'B'])
      expect(query).toBe('SELECT ?, ?, ?')
      expect(params).toEqual(['A', 'B', 'A'])
    })

    it('handles double-digit placeholders', () => {
      const values = Array.from({ length: 12 }, (_, i) => i)
      const { query, params } = rewritePlaceholders('SELECT $12, $1', values)
      expect(query).toBe('SELECT ?, ?')
      expect(params).toEqual([11, 0])
    })

    it('ignores $N inside string literals and quoted identifiers', () => {
      const { query, params } = rewritePlaceholders('SELECT \'$1\' as lit, "col$2" as ident, $1 as real', ['A'])
      expect(query).toBe('SELECT \'$1\' as lit, "col$2" as ident, ? as real')
      expect(params).toEqual(['A'])
    })

    it('ignores $N and quotes inside line and block comments', () => {
      const { query, params } = rewritePlaceholders("SELECT $1 -- don't touch $2 here\n, $2 as b", ['A', 'B'])
      expect(query).toBe("SELECT ? -- don't touch $2 here\n, ? as b")
      expect(params).toEqual(['A', 'B'])

      const block = rewritePlaceholders("SELECT /* can't touch $9 */ $1", ['A'])
      expect(block.query).toBe("SELECT /* can't touch $9 */ ?")
      expect(block.params).toEqual(['A'])
    })

    it('throws on a placeholder beyond the provided values', () => {
      expect(() => rewritePlaceholders('SELECT $1, $2', ['only'])).toThrow(/\$2/)
    })
  })

  describe('splitStatements', () => {
    it('splits on semicolons and trims empties', () => {
      expect(splitStatements('SELECT 1; SELECT 2;\n; SELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
    })

    it('keeps semicolons inside string literals and quoted identifiers', () => {
      expect(splitStatements("SELECT 'a;b'; SELECT \"c;d\" FROM t")).toEqual(["SELECT 'a;b'", 'SELECT "c;d" FROM t'])
    })

    it('keeps escaped quotes inside literals intact', () => {
      expect(splitStatements("SELECT 'it''s;fine'; SELECT 2")).toEqual(["SELECT 'it''s;fine'", 'SELECT 2'])
    })

    it('ignores semicolons in line and block comments', () => {
      expect(splitStatements('SELECT 1 -- not; a split\n; /* also; not */ SELECT 2')).toEqual(['SELECT 1 -- not; a split', '/* also; not */ SELECT 2'])
    })
  })

  it('enables foreign keys and a busy timeout once per instance', async () => {
    const { sql, calls } = createFakeSqlite()
    const db = fromBunSqlite(sql)

    await db.executeSql('SELECT 1')
    await db.executeSql('SELECT 2')

    const pragmas = calls.filter(c => c.text.startsWith('PRAGMA'))
    expect(pragmas.map(c => c.text)).toEqual(['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000'])
  })

  it('converts Date, undefined, and object parameters', async () => {
    const { sql, calls } = createFakeSqlite()
    const db = fromBunSqlite(sql)
    const when = new Date('2026-01-02T03:04:05.678Z')

    await db.executeSql('SELECT $1, $2, $3, $4', [when, undefined, { a: 1 }, ['x']])

    const [call] = afterInit(calls)
    expect(call.values).toEqual(['2026-01-02T03:04:05.678Z', null, '{"a":1}', '["x"]'])
  })

  it('runs multi-statement scripts one statement at a time and concatenates rows', async () => {
    const { sql, calls } = createFakeSqlite({ result: sqlResult([{ n: 1 }]) })
    const db = fromBunSqlite(sql)

    const result = await db.executeSql('INSERT INTO t VALUES (1); SELECT 2; SELECT 3')

    expect(afterInit(calls).map(c => c.text)).toEqual(['INSERT INTO t VALUES (1)', 'SELECT 2', 'SELECT 3'])
    expect(result.rows).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }])
  })

  it('refuses parameterized multi-statement SQL', async () => {
    const { sql, calls } = createFakeSqlite()
    const db = fromBunSqlite(sql)

    const err: any = await db.executeSql('SELECT $1; SELECT $1', ['x']).then(() => null, e => e)
    expect(err?.message).toMatch(/multi-statement/)
    // Nothing from the statement itself ran — only the connection-poisoning rollback guard.
    expect(afterInit(calls).map(c => c.text)).toEqual(['ROLLBACK'])
  })

  it('retries the pragmas when the first init attempt fails', async () => {
    let failFirst = true
    const { sql, calls } = createFakeSqlite({
      errorOn: (text) => {
        if (failFirst && text.startsWith('PRAGMA foreign_keys')) {
          failFirst = false
          return new Error('locked')
        }
        return undefined
      }
    })
    const db = fromBunSqlite(sql)

    await expect(db.executeSql('SELECT 1')).rejects.toThrow(/locked/)
    await db.executeSql('SELECT 2')

    const pragmas = calls.filter(c => c.text.startsWith('PRAGMA foreign_keys'))
    expect(pragmas.length).toBe(2)
  })

  it('copies result rows into a plain array', async () => {
    const { sql } = createFakeSqlite({ result: sqlResult([{ id: 'a' }]) })
    const db = fromBunSqlite(sql)

    const result = await db.executeSql('SELECT 1')

    expect(Array.isArray(result.rows)).toBe(true)
    expect(Object.keys(result.rows as any)).toEqual(['0'])
    expect(result.rows).toEqual([{ id: 'a' }])
  })

  it('maps SQLite constraint codes to SQLSTATE and preserves the original', async () => {
    const cases: Array<[string, string]> = [
      ['SQLITE_CONSTRAINT_UNIQUE', '23505'],
      ['SQLITE_CONSTRAINT_PRIMARYKEY', '23505'],
      ['SQLITE_CONSTRAINT_FOREIGNKEY', '23503'],
      ['SQLITE_CONSTRAINT_CHECK', '23514'],
      ['SQLITE_CONSTRAINT_NOTNULL', '23502']
    ]

    for (const [sqliteCode, sqlState] of cases) {
      const { sql } = createFakeSqlite({
        errorOn: (text) => text === 'BOOM' ? Object.assign(new Error('constraint failed'), { code: sqliteCode }) : undefined
      })
      const db = fromBunSqlite(sql)

      const err: any = await db.executeSql('BOOM').then(() => null, e => e)
      expect(err.code).toBe(sqlState)
      expect(err.sqliteCode).toBe(sqliteCode)
    }
  })

  it('leaves unknown error codes untouched', async () => {
    const { sql } = createFakeSqlite({
      errorOn: (text) => text === 'BOOM' ? Object.assign(new Error('syntax error'), { code: 'SQLITE_ERROR' }) : undefined
    })
    const db = fromBunSqlite(sql)

    const err: any = await db.executeSql('BOOM').then(() => null, e => e)
    expect(err.code).toBe('SQLITE_ERROR')
    expect(err.sqliteCode).toBeUndefined()
  })

  it('issues a best-effort ROLLBACK when a statement fails outside a transaction block', async () => {
    const { sql, calls } = createFakeSqlite({
      errorOn: (text) => text === 'BOOM' ? new Error('boom') : undefined
    })
    const db = fromBunSqlite(sql)

    await expect(db.executeSql('BOOM')).rejects.toThrow('boom')
    expect(afterInit(calls).map(c => c.text)).toEqual(['BOOM', 'ROLLBACK'])
  })

  it('serializes concurrent executeSql calls on one instance', async () => {
    const { sql, calls } = createFakeSqlite({ delayMs: 10 })
    const db1 = fromBunSqlite(sql)
    const db2 = fromBunSqlite(sql)

    const order: string[] = []
    await Promise.all([
      db1.executeSql('FIRST; SECOND').then(() => order.push('first')),
      db2.executeSql('THIRD').then(() => order.push('second'))
    ])

    // The second wrapper's statement must not interleave between the first wrapper's two.
    expect(afterInit(calls).map(c => c.text)).toEqual(['FIRST', 'SECOND', 'THIRD'])
    expect(order).toEqual(['first', 'second'])
  })

  it('wraps withTransaction in BEGIN IMMEDIATE and COMMIT', async () => {
    const { sql, calls } = createFakeSqlite()
    const db = fromBunSqlite(sql)

    const result = await db.withTransaction!(async (tx) => {
      await tx.executeSql('SELECT 1')
      return 'done'
    })

    expect(result).toBe('done')
    expect(afterInit(calls).map(c => c.text)).toEqual(['BEGIN IMMEDIATE', 'SELECT 1', 'COMMIT'])
  })

  it('rolls back withTransaction when the callback throws', async () => {
    const { sql, calls } = createFakeSqlite()
    const db = fromBunSqlite(sql)

    await expect(db.withTransaction!(async () => {
      throw new Error('nope')
    })).rejects.toThrow('nope')

    expect(afterInit(calls).map(c => c.text)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
  })

  it('does not rollback inside the block when an inner statement fails', async () => {
    const { sql, calls } = createFakeSqlite({
      errorOn: (text) => text === 'BOOM' ? Object.assign(new Error('dupe'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }) : undefined
    })
    const db = fromBunSqlite(sql)

    // A caller that tolerates an inner error (like fetch's unique-violation handling) must be
    // able to continue in the same transaction.
    const result = await db.withTransaction!(async (tx) => {
      const err: any = await tx.executeSql('BOOM').then(() => null, e => e)
      expect(err.code).toBe('23505')
      await tx.executeSql('SELECT 1')
      return 'recovered'
    })

    expect(result).toBe('recovered')
    expect(afterInit(calls).map(c => c.text)).toEqual(['BEGIN IMMEDIATE', 'BOOM', 'SELECT 1', 'COMMIT'])
  })

  it('queues executeSql behind an open transaction', async () => {
    const { sql, calls } = createFakeSqlite({ delayMs: 5 })
    const db = fromBunSqlite(sql)

    await Promise.all([
      db.withTransaction!(async (tx) => {
        await tx.executeSql('IN_TX_1')
        await tx.executeSql('IN_TX_2')
      }),
      db.executeSql('OUTSIDE')
    ])

    expect(afterInit(calls).map(c => c.text)).toEqual(['BEGIN IMMEDIATE', 'IN_TX_1', 'IN_TX_2', 'COMMIT', 'OUTSIDE'])
  })
})
