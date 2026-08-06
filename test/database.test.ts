import { describe, it, expect } from './harness.ts'
import { BunBoss } from '../src/index.ts'
import * as helper from './testHelper.ts'

describe('database', function () {
  it('should fail on invalid database host', async function () {
    const boss = new BunBoss({
      connectionString: 'postgres://bobby:tables@wat:12345/northwind',
      connectionTimeoutMillis: 3000
    })

    await expect((async () => {
      await boss.start()
    })()).rejects.toThrow()
  })

  it('can be swapped out via BYODB', async function () {
    const query = 'SELECT something FROM somewhere'

    const mydb = {
      executeSql: async (text: string, values: []): Promise<{ rows: any[]; text: string }> => {
        expect(text).toBe(query)
        return { rows: [], text }
      }
    }

    const boss = new BunBoss({ db: mydb })
    const response = await boss.getDb().executeSql(query)

    // @ts-ignore
    expect(response.text).toBe(query)
  })

  helper.itPglite('rolls back the transaction when the callback throws and commits otherwise', async function () {
    const db = await helper.getDb()

    await expect(
      db.withTransaction(async () => { throw new Error('rollback me') })
    ).rejects.toThrow('rollback me')

    const result = await db.withTransaction(async (tx) => {
      const { rows } = await tx.executeSql('select 1 as one')
      return rows[0].one
    })
    expect(parseInt(result, 10)).toBe(1)

    await db.close()
  })

  helper.itPglite('close is idempotent', async function () {
    const db = await helper.getDb()
    await db.close()
    await db.close()
  })

  helper.itPglite('sets the default application_name on its connections', async function () {
    const db = await helper.getDb()

    const { rows } = await db.executeSql('SHOW application_name')
    expect(rows[0].application_name).toBe('bunboss')

    await db.close()
  })
})
