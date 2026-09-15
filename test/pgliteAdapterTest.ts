import { describe, it, expect } from 'vitest'
import { fromPglite, type PGliteLike } from '../src/adapters/index.ts'

// Records how each call was routed (query vs exec) so we can assert the parameterized-vs-DDL split.
function createFakePglite (): PGliteLike & { calls: Array<{ method: 'query' | 'exec', text: string, params?: unknown[] }> } {
  const calls: Array<{ method: 'query' | 'exec', text: string, params?: unknown[] }> = []
  return {
    calls,
    async query (text: string, params?: unknown[]): Promise<{ rows: any[] }> {
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

// A PGliteWorker-shaped fake: same query/exec surface, plus the leader-change subscription and the
// error the worker raises when leadership moves mid-call. Leadership is driven by hand because real
// election needs several browser tabs, which a node test cannot stand up.
function createFakeWorker () {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  let failNext: Error | null = null
  let hangNext = false

  return {
    calls,
    electNewLeader: () => { for (const fn of [...listeners]) fn() },
    failNextWith: (err: Error) => { failNext = err },
    // Stands in for the upstream hang: a statement that never settles either way.
    hangNext: () => { hangNext = true },
    listenerCount: () => listeners.size,
    async query (text: string): Promise<{ rows: any[] }> {
      calls.push(text)
      if (hangNext) {
        hangNext = false
        return await new Promise<{ rows: any[] }>(() => {})
      }
      if (failNext) {
        const err = failNext
        failNext = null
        throw err
      }
      return { rows: [] }
    },
    async exec (text: string) {
      calls.push(text)
      if (failNext) {
        const err = failNext
        failNext = null
        throw err
      }
      return [{ rows: [] }]
    },
    onLeaderChange (callback: () => void) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}

const LEADER_CHANGED = () => new Error('Leader changed, pending operation in indeterminate state')

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

  it('does not expose listen when the instance lacks it', () => {
    const db = fromPglite(createFakePglite())
    expect(db.listen).toBeUndefined()
  })

  it('wires LISTEN/NOTIFY through to the PGlite instance when supported', async () => {
    let registered: { channel: string, callback: (p: string) => void } | undefined
    let unsubscribed = false
    const pglite = {
      ...createFakePglite(),
      async listen (channel: string, callback: (p: string) => void) {
        registered = { channel, callback }
        return async () => { unsubscribed = true }
      }
    }
    const db = fromPglite(pglite)
    expect(typeof db.listen).toBe('function')

    const payloads: string[] = []
    let reconnects = 0
    const handle = await db.listen!('pgboss_chan', p => payloads.push(p), () => { reconnects++ })

    expect(registered?.channel).toBe('pgboss_chan')
    expect(reconnects).toBe(1) // onReconnect fires once after the initial subscribe

    registered!.callback('q1')
    expect(payloads).toEqual(['q1'])

    await handle.close()
    expect(unsubscribed).toBe(true)
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

  it('applies session statements once on a plain instance', async () => {
    const pglite = createFakePglite()
    const db = fromPglite(pglite)

    await db.setSessionStatements!(["SET pgboss.test_clock = 'on'"])

    expect(pglite.calls.map(c => c.text)).toEqual(["SET pgboss.test_clock = 'on'"])
  })

  it('reapplies session statements when the worker elects a new leader', async () => {
    const worker = createFakeWorker()
    const db = fromPglite(worker)

    await db.setSessionStatements!(["SET pgboss.test_clock = 'on'"])
    expect(worker.calls).toEqual(["SET pgboss.test_clock = 'on'"])

    // The new leader constructs a fresh PGlite over the same data directory, so the SET is gone.
    worker.electNewLeader()
    await db.executeSql('SELECT 1')

    expect(worker.calls).toEqual(["SET pgboss.test_clock = 'on'", "SET pgboss.test_clock = 'on'", 'SELECT 1'])
  })

  it('holds statements behind the reapply so none reaches an unprepared session', async () => {
    const worker = createFakeWorker()
    const db = fromPglite(worker)

    await db.setSessionStatements!(["SET pgboss.test_clock = 'on'"])
    worker.electNewLeader()

    // Issued without awaiting anything in between: the setup must still land first.
    const [, second] = await Promise.all([db.executeSql('SELECT 1'), db.executeSql('SELECT 2')])

    expect(worker.calls.indexOf('SELECT 1')).toBeGreaterThan(1)
    expect(second.rows).toEqual([])
  })

  it('keeps watching for leader changes after the statements are cleared', async () => {
    const worker = createFakeWorker()
    const db = fromPglite(worker)

    // The subscription is not tied to having statements to reapply: it also fails in-flight
    // statements, which matters whether or not a TestClock is involved.
    expect(worker.listenerCount()).toBe(1)

    await db.setSessionStatements!(["SET pgboss.test_clock = 'on'"])
    await db.setSessionStatements!([])
    expect(worker.listenerCount()).toBe(1)

    // Nothing left to reapply, so a leader change replays nothing.
    worker.electNewLeader()
    await db.executeSql('SELECT 1')
    expect(worker.calls).toEqual(["SET pgboss.test_clock = 'on'", 'SELECT 1'])
  })

  // Upstream, a statement that holds PGliteWorker's transaction lock when leadership moves never
  // settles: the rpc in _runExclusiveTransaction's `finally` is posted to a tab channel the new
  // leader has not attached to, so nothing replies and nothing rejects it. Verified in a browser
  // against real election. The adapter fails such a statement itself rather than hang.
  it('fails a statement left hanging by a leader change', async () => {
    const worker = createFakeWorker()
    const db = fromPglite(worker)

    worker.hangNext()
    const hung = db.executeSql('SELECT pg_sleep(5)')
    const settled = expect(hung).rejects.toThrow('Leader changed')

    worker.electNewLeader()
    await settled

    // Same treatment a statement that did settle gets: no ROLLBACK to a session that was never in
    // the transaction.
    expect(worker.calls).toEqual(['SELECT pg_sleep(5)'])
  })

  it('does not fail statements issued after the leader change settled', async () => {
    const worker = createFakeWorker()
    const db = fromPglite(worker)

    worker.electNewLeader()
    await expect(db.executeSql('SELECT 1')).resolves.toEqual({ rows: [] })
  })

  it('does not roll back against a session that never held the transaction', async () => {
    const worker = createFakeWorker()
    const db = fromPglite(worker)

    worker.failNextWith(LEADER_CHANGED())
    await expect(db.executeSql('UPDATE job SET x = 1')).rejects.toThrow('Leader changed')

    // A ROLLBACK here would go to the new leader, which was never in that transaction.
    expect(worker.calls).toEqual(['UPDATE job SET x = 1'])
  })

  it('still rolls back an ordinary failed statement', async () => {
    const worker = createFakeWorker()
    const db = fromPglite(worker)

    worker.failNextWith(new Error('syntax error'))
    await expect(db.executeSql('SELEC 1')).rejects.toThrow('syntax error')

    expect(worker.calls).toEqual(['SELEC 1', 'ROLLBACK'])
  })
})
