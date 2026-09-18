import { expect } from 'vitest'
import { PgBoss } from '../src/index.ts'
import * as helper from './testHelper.ts'

describe('database', function () {
  it('should fail on invalid database host', async function () {
    const boss = new PgBoss({
      connectionString: 'postgres://bobby:tables@wat:12345/northwind',
      connectionTimeoutMillis: 3000
    })

    await expect(async () => {
      await boss.start()
    }).rejects.toThrow()
  })

  helper.itPglite('applies session statements to an open pool, and refuses when one is in use', async function () {
    const db = await helper.getDb()
    const statements = ["SET application_name = 'pgboss_session_statements_test'"]

    try {
      // Nothing is checked out during start(), which is the only time pg-boss sets these on an open
      // pool - so the set can be made total there and the sweep below is what makes it so.
      await db.executeSql('SELECT 1')
      await db.setSessionStatements(statements)

      const { rows } = await db.executeSql('SHOW application_name')
      expect(rows[0].application_name).toBe('pgboss_session_statements_test')

      // @ts-ignore reaching the pool, the way the pool-lifecycle tests do
      const held = await db.pool.connect()

      try {
        // A connection someone else holds cannot be reached, so the set would land on some sessions
        // and not others. Refused rather than applied in half.
        await expect(db.setSessionStatements(statements)).rejects.toThrow('already checked out')

        // Clearing is safe whatever is checked out: it only stops stamping connections opened
        // later, and the statements it would have run are the ones already applied.
        await db.setSessionStatements([])
      } finally {
        held.release()
      }
    } finally {
      await db.close()
    }
  })

  it('can be swapped out via BYODB', async function () {
    const query = 'SELECT something FROM somewhere'

    const mydb = {
      executeSql: async (text: string, values: []): Promise<{ rows: any[]; text: string }> => {
        expect(text).toBe(query)
        return { rows: [], text }
      }
    }

    const boss = new PgBoss({ db: mydb })
    const response = await boss.getDb().executeSql(query)

    // @ts-ignore
    expect(response.text).toBe(query)
  })
})
