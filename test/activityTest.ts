import { expect } from 'vitest'
import { trackActivity } from '../src/activity.ts'
import { delay } from '../src/tools.ts'
import type { IDatabase, TransactionHandle } from '../src/types.ts'

function gate () {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

const rows = { rows: [] }

describe('trackActivity', function () {
  it('reports quiet at once when nothing has run', async function () {
    const { idle } = trackActivity({ executeSql: async () => rows })
    expect(await idle()).toBe(false)
  })

  it('waits for a statement in flight, then reports that it waited', async function () {
    const g = gate()
    const inner: IDatabase = { executeSql: async () => { await g.promise; return rows } }
    const { db, idle } = trackActivity(inner)

    const statement = db.executeSql('SELECT 1')
    let settled = false
    const waiting = idle().then(waited => { settled = true; return waited })

    await delay(20)
    expect(settled).toBe(false)

    g.open()
    await statement
    expect(await waiting).toBe(true)
  })

  it('waits for a statement started from the continuation of one that settled', async function () {
    const ran: string[] = []
    const { db, idle } = trackActivity({
      executeSql: async (text: string) => { await delay(5); ran.push(text); return rows }
    })

    db.executeSql('first').then(() => db.executeSql('second'))

    expect(await idle()).toBe(true)
    expect(ran).toEqual(['first', 'second'])
  })

  it('a failed statement still leaves the count', async function () {
    const inner: IDatabase = { executeSql: async () => { throw new Error('boom') } }
    const { db, idle } = trackActivity(inner)

    await expect(db.executeSql('SELECT 1')).rejects.toThrow('boom')
    expect(await idle()).toBe(false)
  })

  it('counts the transaction calls but not the time a transaction stays open', async function () {
    const statementGate = gate()
    const commitGate = gate()
    const tx: TransactionHandle = {
      db: { executeSql: async () => { await statementGate.promise; return rows } },
      commit: async () => { await commitGate.promise },
      rollback: async () => {}
    }
    const { db, idle } = trackActivity({ executeSql: async () => rows, beginTransaction: async () => tx })

    const handle = await db.beginTransaction!()
    expect(await idle()).toBe(false)

    const statement = handle.db.executeSql('UPDATE x')
    const duringStatement = idle()
    statementGate.open()
    await statement
    expect(await duringStatement).toBe(true)

    expect(await idle()).toBe(false)

    const commit = handle.commit()
    const duringCommit = idle()
    commitGate.open()
    await commit
    expect(await duringCommit).toBe(true)
  })

  it('leaves listen uncounted and missing capabilities missing', async function () {
    const inner: IDatabase = {
      executeSql: async () => rows,
      listen: () => new Promise(() => {})
    }
    const { db, idle } = trackActivity(inner)

    db.listen!('channel', () => {}, () => {})
    expect(await idle()).toBe(false)
    expect(typeof db.beginTransaction).toBe('undefined')
  })

  it('forwards other members, bound to the original so private fields keep working', async function () {
    class Adapter {
      readonly _pgbdb = true
      opened = true
      #calls = 0
      async executeSql () { this.#calls++; return rows }
      calls () { return this.#calls }
    }
    const inner = new Adapter()
    const { db } = trackActivity(inner)

    await db.executeSql()
    expect(db.calls()).toBe(1)
    expect(db.opened).toBe(true)
    expect('_pgbdb' in db).toBe(true)
  })
})
