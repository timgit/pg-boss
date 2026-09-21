import { describe, it, expect } from 'vitest'
import { fromBunSql, type BunSqlLike } from '../src/adapters/bun.ts'

// Bun's SQL client only exists inside the Bun runtime, so these run the adapter against a fake
// client that reproduces the three behaviours pg-boss has to absorb: it cannot encode a JS array,
// it refuses a raw BEGIN unless the connection is reserved, and it reports SQLSTATE in `errno`.
// The end-to-end coverage on a real client lives in test/bun/, run by `npm run test:bun`.

interface Call { text: string, values?: unknown[], reserved: boolean }

function fakeBunSql (respond: (call: Call) => unknown = () => []) {
  const calls: Call[] = []
  let reserveCount = 0
  let releaseCount = 0

  const unsafe = (reserved: boolean) => async (text: string, values?: unknown[]) => {
    if (!reserved && /^\s*BEGIN\b/i.test(text)) {
      throw new Error('Only use sql.begin, sql.reserved or max: 1')
    }

    // Bun stringifies an array parameter instead of encoding it, which is what produces
    // `malformed array literal` server-side. Fail loudly here so a regression cannot pass.
    if (values?.some(Array.isArray)) {
      throw new Error('malformed array literal')
    }

    const call = { text, values, reserved }
    calls.push(call)
    return respond(call)
  }

  const client = {
    unsafe: unsafe(false),
    async reserve () {
      reserveCount++
      return { unsafe: unsafe(true), release: () => { releaseCount++ } }
    }
  } satisfies BunSqlLike

  return { client, calls, counts: () => ({ reserveCount, releaseCount }) }
}

describe('bun adapter', () => {
  it('expands an array parameter the client could not have encoded', async () => {
    const { client, calls } = fakeBunSql()

    await fromBunSql(client).executeSql(
      'WHERE name = $1 AND id = ANY($2::uuid[])',
      ['q', ['a', 'b']]
    )

    expect(calls[0]?.text).toBe('WHERE name = $1 AND id = ANY(ARRAY[$2,$3]::uuid[])')
    expect(calls[0]?.values).toEqual(['q', 'a', 'b'])
  })

  it('leaves a JSON array bound whole', async () => {
    const { client, calls } = fakeBunSql()

    // an array cast to json is a JSON array, not a postgres array: expanding it would store
    // something else. Bun encodes this one correctly, so there is nothing to work around.
    await expect(fromBunSql(client).executeSql('SELECT $1::jsonb', [[1, 2]]))
      .rejects.toThrow('malformed array literal')

    expect(calls).toHaveLength(0)
  })

  it('runs a transaction script on a reserved connection and releases it', async () => {
    const { client, calls, counts } = fakeBunSql()

    await fromBunSql(client).executeSql('\n    BEGIN;\n    SELECT 1;\n    COMMIT;\n  ')

    expect(calls[0]?.reserved).toBe(true)
    expect(counts()).toEqual({ reserveCount: 1, releaseCount: 1 })
  })

  it('releases the reserved connection when the script throws', async () => {
    const { client, counts } = fakeBunSql(() => { throw new Error('deadlock detected') })

    await expect(fromBunSql(client).executeSql('BEGIN; SELECT 1; COMMIT;'))
      .rejects.toThrow('deadlock detected')

    expect(counts()).toEqual({ reserveCount: 1, releaseCount: 1 })
  })

  it('keeps ordinary statements on the pool', async () => {
    const { client, calls, counts } = fakeBunSql()

    await fromBunSql(client).executeSql('SELECT 1')

    expect(calls[0]?.reserved).toBe(false)
    expect(counts().reserveCount).toBe(0)
  })

  it('passes no values array when there is nothing to bind', async () => {
    // the parameterless form is what selects the simple protocol, and a multi-statement script
    // only runs there
    const { client, calls } = fakeBunSql()

    await fromBunSql(client).executeSql('SELECT 1; SELECT 2;')

    expect(calls[0]?.values).toBeUndefined()
  })

  it('returns single-statement rows as they are', async () => {
    const { client } = fakeBunSql(() => [{ a: 1 }, { a: 2 }])

    const result = await fromBunSql(client).executeSql('SELECT a FROM t')

    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('flattens the per-statement results of a script', async () => {
    // a RETURNING in the middle of a BEGIN/COMMIT block would otherwise be lost behind the
    // trailing COMMIT's empty result
    const { client } = fakeBunSql(() => [[], [{ id: 'x' }], []])

    const result = await fromBunSql(client).executeSql('BEGIN; DELETE FROM t RETURNING id; COMMIT;')

    expect(result.rows).toEqual([{ id: 'x' }])
  })

  it('tolerates a result that is not an array', async () => {
    const { client } = fakeBunSql(() => undefined)

    const result = await fromBunSql(client).executeSql('SET LOCAL lock_timeout = 30000')

    expect(result.rows).toEqual([])
  })

  it('moves the SQLSTATE onto code, where pg-boss reads it', async () => {
    // 23505 from a lost fetch race is control flow, not a failure. Pg-boss only recognises it
    // as such if the state is where node-postgres puts it
    const { client } = fakeBunSql(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: 'ERR_POSTGRES_SERVER_ERROR',
        errno: '23505'
      })
    })

    await expect(fromBunSql(client).executeSql('SELECT 1')).rejects.toMatchObject({ code: '23505' })
  })

  it('exposes listen when the client has it, and closes the subscription', async () => {
    const { client } = fakeBunSql()
    let unlistened = false
    const subscribed: unknown[] = []

    const listening = {
      ...client,
      async listen (channel: string, onNotification: (payload: string) => void, onSubscribe?: () => void) {
        subscribed.push(channel, onNotification, onSubscribe)
        return { unlisten: () => { unlistened = true } }
      }
    } satisfies BunSqlLike

    const onNotification = () => {}
    const onReconnect = () => {}

    const handle = await fromBunSql(listening).listen!('pgboss', onNotification, onReconnect)

    // Bun's third argument fires on the initial subscribe and after each reconnect, which is what
    // pg-boss's onReconnect expects, so it is passed straight through
    expect(subscribed).toEqual(['pgboss', onNotification, onReconnect])

    await handle.close()
    expect(unlistened).toBe(true)
  })

  it('omits listen when the client has none, so the notifier falls back to polling', async () => {
    // sql.listen() arrived in Bun 1.4.0; on an older runtime pg-boss must see no capability at all
    const { client } = fakeBunSql()

    expect(fromBunSql(client).listen).toBeUndefined()
  })

  it('leaves a non-server error alone', async () => {
    const { client } = fakeBunSql(() => {
      throw Object.assign(new Error('connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' })
    })

    await expect(fromBunSql(client).executeSql('SELECT 1'))
      .rejects.toMatchObject({ code: 'ERR_POSTGRES_CONNECTION_CLOSED' })
  })
})
