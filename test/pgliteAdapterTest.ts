import { describe, it, expect } from 'vitest'
import { fromPglite, type PGliteLike } from '../src/adapters/index.ts'

// Records how each call was routed (query vs exec) so we can assert the parameterized-vs-DDL split.
function createFakePglite (): PGliteLike & { calls: Array<{ method: 'query' | 'exec', text: string, params?: unknown[] }> } {
  const calls: Array<{ method: 'query' | 'exec', text: string, params?: unknown[] }> = []
  return {
    calls,
    async query (text: string, params?: unknown[]) {
      calls.push({ method: 'query', text, params })
      return { rows: [{ id: '1' }] }
    },
    async exec (text: string) {
      calls.push({ method: 'exec', text })
      // exec returns one result per statement; mimic a multi-statement DDL block
      return [{ rows: [] }, { rows: [{ last: true }] }]
    }
  }
}

describe('pglite adapter', () => {
  it('routes parameterized queries through query()', async () => {
    const pglite = createFakePglite()
    const db = fromPglite(pglite)

    const result = await db.executeSql('SELECT * FROM job WHERE name = $1', ['q1'])

    expect(pglite.calls).toEqual([{ method: 'query', text: 'SELECT * FROM job WHERE name = $1', params: ['q1'] }])
    expect(result.rows).toEqual([{ id: '1' }])
  })

  it('routes parameterless (multi-statement DDL) through exec()', async () => {
    const pglite = createFakePglite()
    const db = fromPglite(pglite)

    const result = await db.executeSql('BEGIN; CREATE TABLE x (id int); COMMIT;')

    expect(pglite.calls).toEqual([{ method: 'exec', text: 'BEGIN; CREATE TABLE x (id int); COMMIT;' }])
    // returns the last statement's rows
    expect(result.rows).toEqual([{ last: true }])
  })

  it('treats an empty values array as parameterless', async () => {
    const pglite = createFakePglite()
    const db = fromPglite(pglite)

    await db.executeSql('CREATE INDEX foo ON job (name)', [])

    expect(pglite.calls[0].method).toBe('exec')
  })

  it('rolls back an aborted transaction on error before rethrowing', async () => {
    // Single-connection self-heal: a failed statement must not leave the connection in an aborted
    // transaction that poisons the next query (a pool would just hand out a fresh connection).
    const calls: string[] = []
    const boom = new Error('boom')
    const pglite = {
      async query (text: string) {
        calls.push(text)
        if (text === 'ROLLBACK') return { rows: [] }
        throw boom
      },
      async exec () { return [{ rows: [] }] }
    }
    const db = fromPglite(pglite as any)

    await expect(db.executeSql('SELECT 1', ['x'])).rejects.toBe(boom)
    expect(calls).toEqual(['SELECT 1', 'ROLLBACK'])
  })
})
