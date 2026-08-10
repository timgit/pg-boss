import { describe, it, expect } from './harness.ts'
import { fromBunSql, type BunSqlLike, type BunReservedLike } from '../src/adapters/index.ts'

type Call = { target: 'pool' | 'reserved', text: string, values?: unknown[] }

// Bun's SQLResultArray is the row array itself with metadata hung off it as enumerable own
// properties. Keep those extra keys so the tests exercise the real thing, including the adapter
// copying the rows into a plain array.
function sqlResult (rows: any[]): any {
  return Object.assign(rows, { count: rows.length, command: 'SELECT' })
}

function unsafeTransactionError (): any {
  return Object.assign(new Error('Only use sql.begin, sql.reserved or max: 1'), {
    code: 'ERR_POSTGRES_UNSAFE_TRANSACTION'
  })
}

function createFakeBunSql (options: {
  result?: any
  poolError?: () => unknown
  reservedResult?: any
  reservedError?: () => unknown
  noReserve?: boolean
  // Bun gives all three handles a reserve(); `release` marks a reserved connection and `savepoint`
  // a transaction scope, which is how the adapter identifies the pool.
  handle?: 'pool' | 'reserved' | 'transaction'
} = {}) {
  const calls: Call[] = []
  let released = 0

  const sql: BunSqlLike = {
    async unsafe (text: string, values?: unknown[]) {
      calls.push({ target: 'pool', text, values })

      if (options.poolError) {
        throw options.poolError()
      }

      return options.result ?? sqlResult([{ id: '1' }])
    }
  }

  if (options.handle === 'reserved') {
    sql.release = () => {}
  }

  if (options.handle === 'transaction') {
    sql.savepoint = () => {}
  }

  if (!options.noReserve) {
    sql.reserve = async (): Promise<BunReservedLike> => ({
      async unsafe (text: string, values?: unknown[]) {
        calls.push({ target: 'reserved', text, values })

        if (options.reservedError && text !== 'ROLLBACK') {
          throw options.reservedError()
        }

        return options.reservedResult ?? sqlResult([{ id: '2' }])
      },
      release () {
        released++
      }
    })
  }

  return { sql, calls, released: () => released }
}

describe('bun adapter', () => {
  it('passes native $n placeholders and values straight through', async () => {
    const { sql, calls } = createFakeBunSql()
    const db = fromBunSql(sql)

    const result = await db.executeSql('SELECT * FROM job WHERE name = $1 AND priority > $2', ['q1', 5])

    expect(calls).toEqual([{
      target: 'pool',
      text: 'SELECT * FROM job WHERE name = $1 AND priority > $2',
      values: ['q1', 5]
    }])
    expect(result.rows).toStrictEqual([{ id: '1' }])
  })

  it('copies a flat result array into plain { rows }', async () => {
    const { sql } = createFakeBunSql({ result: sqlResult([{ a: 1 }, { a: 2 }]) })

    const result = await fromBunSql(sql).executeSql('SELECT a FROM t')

    // strict equality also asserts the driver's count/command metadata did not come along
    expect(result.rows).toStrictEqual([{ a: 1 }, { a: 2 }])
  })

  it('flattens the per-statement arrays of a multi-statement query', async () => {
    // A parameterless block resolves to one row array per statement, and the rows of a RETURNING
    // in the middle must survive statements that produce none.
    const { sql } = createFakeBunSql({ result: [[], [{ id: 'x' }], []] })

    const result = await fromBunSql(sql).executeSql('SET LOCAL lock_timeout = 30000; DELETE FROM job RETURNING id; ANALYZE job;')

    expect(result.rows).toEqual([{ id: 'x' }])
  })

  it('returns an empty row set for a query that produced no rows', async () => {
    const { sql } = createFakeBunSql({ result: sqlResult([]) })

    const result = await fromBunSql(sql).executeSql('SELECT 1 WHERE false')

    expect(result.rows).toStrictEqual([])
  })

  describe('array parameters', () => {
    const capture = async (values: unknown[]) => {
      const { sql, calls } = createFakeBunSql()
      await fromBunSql(sql).executeSql('SELECT $1::text[] as a', values)
      return calls[0].values
    }

    it('encodes an array as a postgres array literal', async () => {
      expect(await capture([['a', 'b']])).toEqual(['{"a","b"}'])
    })

    it('encodes an empty array', async () => {
      expect(await capture([[]])).toEqual(['{}'])
    })

    it('encodes null and undefined elements as NULL', async () => {
      expect(await capture([[null, 'x', undefined]])).toEqual(['{NULL,"x",NULL}'])
    })

    it('escapes quotes and backslashes and keeps separators literal', async () => {
      expect(await capture([['a,b', 'c"d', 'e\\f', '{g}']])).toEqual(['{"a,b","c\\"d","e\\\\f","{g}"}'])
    })

    it('encodes dates and numbers as text elements', async () => {
      expect(await capture([[new Date(0), 42]])).toEqual(['{"1970-01-01T00:00:00.000Z","42"}'])
    })

    it('recurses into nested arrays', async () => {
      expect(await capture([[['a'], ['b']]])).toEqual(['{{"a"},{"b"}}'])
    })

    it('encodes a bare date parameter as iso text', async () => {
      // Postgres parses ISO text into the identical timestamptz, and the encoding survives
      // `prepare: false`, where bun's own Date binding falls back to an unparseable String(value).
      const { sql, calls } = createFakeBunSql()

      await fromBunSql(sql).executeSql('SELECT $1::timestamptz', [new Date(0)])

      expect(calls[0].values).toEqual(['1970-01-01T00:00:00.000Z'])
    })

    it('leaves other non-array values alone', async () => {
      const { sql, calls } = createFakeBunSql()

      await fromBunSql(sql).executeSql('SELECT $1, $2, $3', ['q1', 7, null])

      expect(calls[0].values).toEqual(['q1', 7, null])
    })
  })

  describe('json parameters', () => {
    const capture = async (text: string, values?: unknown[]) => {
      const { sql, calls } = createFakeBunSql()
      await fromBunSql(sql).executeSql(text, values)
      return calls[0]
    }

    it('casts a json placeholder through text', async () => {
      const call = await capture('SELECT * FROM json_to_recordset($1::json) AS x (id uuid)', ['[]'])
      expect(call.text).toBe('SELECT * FROM json_to_recordset($1::text::json) AS x (id uuid)')
    })

    it('casts a jsonb placeholder through text, whatever the spacing or case', async () => {
      const call = await capture('SELECT $1 :: JSONB, $2::jsonb', ['{}', '{}'])
      expect(call.text).toBe('SELECT $1::text::JSONB, $2::text::jsonb')
    })

    it('leaves literal json casts untouched', async () => {
      const call = await capture("SELECT '{\"a\":1}'::jsonb, data::jsonb FROM job")
      expect(call.text).toBe("SELECT '{\"a\":1}'::jsonb, data::jsonb FROM job")
    })

    it('passes an already encoded json string through unchanged', async () => {
      const call = await capture('SELECT $1::json', ['[{"id":null}]'])
      expect(call.values).toEqual(['[{"id":null}]'])
    })

    it('encodes a live object bound to a json cast', async () => {
      // complete()/fail() route their output through serialize-error, which returns an object.
      const call = await capture('UPDATE job SET output = $1::jsonb', [{ value: { message: 'boom' } }])
      expect(call.values).toEqual(['{"value":{"message":"boom"}}'])
    })

    it('encodes an array bound to a json cast rather than treating it as a postgres array', async () => {
      const call = await capture('SELECT $1::jsonb', [[1, 2, 3]])
      expect(call.values).toEqual(['[1,2,3]'])
    })

    it('keeps a null json argument as sql NULL', async () => {
      const call = await capture('SELECT $1::jsonb, $2::jsonb', [null, undefined])
      expect(call.values).toEqual([null, undefined])
    })

    it('casts a jsonb containment placeholder that carries an explicit cast', async () => {
      // findJobs filters with `data @> $n::jsonb`; the cast is what the classifier keys on.
      const call = await capture('SELECT * FROM job WHERE data @> $1::jsonb', ['{"type":"email"}'])
      expect(call.text).toBe('SELECT * FROM job WHERE data @> $1::text::jsonb')
      expect(call.values).toEqual(['{"type":"email"}'])
    })

    it('leaves a bare containment placeholder untouched', async () => {
      // A json placeholder is recognised only by its cast, so plans.ts must write `$n::jsonb`; a
      // bare `data @> $n` passes through and would double-encode (the plansSnapshot test guards this).
      const call = await capture('SELECT * FROM job WHERE data @> $1', [{ type: 'email' }])
      expect(call.text).toBe('SELECT * FROM job WHERE data @> $1')
      expect(call.values).toEqual([{ type: 'email' }])
    })

    it('casts a two-digit placeholder without splitting its index', async () => {
      const values = [...Array(10).fill('x'), { keep: true }, { type: 'email' }]

      const call = await capture('SELECT * FROM job WHERE a = $11 AND data @> $12::jsonb', values)

      expect(call.text).toBe('SELECT * FROM job WHERE a = $11 AND data @> $12::text::jsonb')
      expect(call.values![10]).toEqual({ keep: true })
      expect(call.values![11]).toBe('{"type":"email"}')
    })

    it('only json-encodes the arguments that carry a json cast', async () => {
      const call = await capture('SELECT $1, $2::jsonb FROM t WHERE id = ANY($3::uuid[])', [
        { plain: true },
        { output: 1 },
        ['a']
      ])
      expect(call.values).toEqual([{ plain: true }, '{"output":1}', '{"a"}'])
    })
  })

  describe('transaction blocks', () => {
    it('runs a transaction block on a reserved connection', async () => {
      const { sql, calls, released } = createFakeBunSql({ reservedResult: [[], [{ id: 'x' }], []] })

      const result = await fromBunSql(sql).executeSql('BEGIN; DELETE FROM job RETURNING id; COMMIT;')

      expect(calls.map(call => call.target)).toEqual(['reserved'])
      expect(result.rows).toEqual([{ id: 'x' }])
      expect(released()).toBe(1)
    })

    it('reserves for a block whose BEGIN sits behind a comment', async () => {
      // Bun's own guard is a prefix test that does not look past a leading comment, so a block like
      // this would otherwise be spread across pooled connections without ever being rejected.
      const { sql, calls } = createFakeBunSql()

      await fromBunSql(sql).executeSql('-- maintenance\nBEGIN; DELETE FROM job; COMMIT;')

      expect(calls.map(call => call.target)).toEqual(['reserved'])
    })

    it('reserves for START TRANSACTION as well', async () => {
      const { sql, calls } = createFakeBunSql()

      await fromBunSql(sql).executeSql('START TRANSACTION; DELETE FROM job; COMMIT;')

      expect(calls.map(call => call.target)).toEqual(['reserved'])
    })

    it('keeps an ordinary parameterless query on the pool', async () => {
      const { sql, calls, released } = createFakeBunSql()

      await fromBunSql(sql).executeSql('SELECT name FROM queue')

      expect(calls.map(call => call.target)).toEqual(['pool'])
      expect(released()).toBe(0)
    })

    it('retries on a reserved connection when the pool rejects unanticipated transaction control', async () => {
      // Bun rejects before running any of the statement, so replaying it is safe.
      const { sql, calls } = createFakeBunSql({ poolError: unsafeTransactionError })

      await fromBunSql(sql).executeSql('SELECT 1')

      expect(calls.map(call => call.target)).toEqual(['pool', 'reserved'])
    })

    it('rolls back and releases when the reserved statement fails', async () => {
      const boom = new Error('boom')
      const { sql, calls, released } = createFakeBunSql({ reservedError: () => boom })

      await expect(fromBunSql(sql).executeSql('BEGIN; bad; COMMIT;')).rejects.toBe(boom)

      expect(calls.map(call => call.text)).toEqual(['BEGIN; bad; COMMIT;', 'ROLLBACK'])
      expect(released()).toBe(1)
    })

    it('rethrows other errors without reserving a connection', async () => {
      const boom = Object.assign(new Error('syntax'), { code: 'ERR_POSTGRES_SYNTAX_ERROR' })
      const { sql, calls } = createFakeBunSql({ poolError: () => boom })

      await expect(fromBunSql(sql).executeSql('SELECT bad')).rejects.toBe(boom)

      expect(calls.map(call => call.target)).toEqual(['pool'])
    })

    it('never reserves from inside a transaction scope', async () => {
      // Reserving would run the block on another connection, committing it independently of the
      // caller's work. Let bun reject it instead.
      const err = unsafeTransactionError()
      const { sql, calls } = createFakeBunSql({ handle: 'transaction', poolError: () => err })

      await expect(fromBunSql(sql).executeSql('BEGIN; COMMIT;')).rejects.toBe(err)

      expect(calls.map(call => call.target)).toEqual(['pool'])
    })

    it('never reserves from an already reserved connection', async () => {
      const { sql, calls } = createFakeBunSql({ handle: 'reserved' })

      await fromBunSql(sql).executeSql('BEGIN; DELETE FROM job; COMMIT;')

      expect(calls.map(call => call.target)).toEqual(['pool'])
    })

    it('rethrows when the handle cannot reserve at all', async () => {
      const err = unsafeTransactionError()
      const { sql, calls } = createFakeBunSql({ poolError: () => err, noReserve: true })

      await expect(fromBunSql(sql).executeSql('BEGIN; COMMIT;')).rejects.toBe(err)

      expect(calls.map(call => call.target)).toEqual(['pool'])
    })

    it('never reserves for a parameterized query', async () => {
      const err = unsafeTransactionError()
      const { sql, calls } = createFakeBunSql({ poolError: () => err })

      await expect(fromBunSql(sql).executeSql('SELECT $1', ['x'])).rejects.toBe(err)

      expect(calls.map(call => call.target)).toEqual(['pool'])
    })
  })

  describe('error codes', () => {
    const serverError = (errno: string) => Object.assign(new Error('nope'), {
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno
    })

    it('promotes the sqlstate from errno onto code', async () => {
      // bun-boss tolerates 23505 on fetch and translates 22012 on insert, both keyed on err.code.
      const { sql } = createFakeBunSql({ poolError: () => serverError('23505') })

      await expect(fromBunSql(sql).executeSql('SELECT 1', ['x'])).rejects.toMatchObject({
        code: '23505',
        bunCode: 'ERR_POSTGRES_SERVER_ERROR'
      })
    })

    it('promotes the sqlstate raised on the reserved connection too', async () => {
      const { sql } = createFakeBunSql({
        poolError: unsafeTransactionError,
        reservedError: () => serverError('22012')
      })

      await expect(fromBunSql(sql).executeSql('BEGIN; bad; COMMIT;')).rejects.toMatchObject({ code: '22012' })
    })

    it('leaves an error that carries no sqlstate alone', async () => {
      const err = Object.assign(new Error('closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' })
      const { sql } = createFakeBunSql({ poolError: () => err })

      await expect(fromBunSql(sql).executeSql('SELECT 1')).rejects.toMatchObject({
        code: 'ERR_POSTGRES_CONNECTION_CLOSED'
      })
    })
  })

  it('does not expose listen, as bun implements neither LISTEN nor NOTIFY', () => {
    const { sql } = createFakeBunSql()
    expect(fromBunSql(sql).listen).toBeUndefined()
  })
})
