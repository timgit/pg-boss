import assert from 'node:assert'
import { PgBoss } from '../src/index.ts'

describe('database', function () {
  it('should fail on invalid database host', async function () {
    const boss = new PgBoss({
      connectionString: 'postgres://bobby:tables@wat:12345/northwind',
      connectionTimeoutMillis: 3000
    })

    await assert.rejects(async () => {
      await boss.start()
    })
  })

  it('can be swapped out via BYODB', async function () {
    const query = 'SELECT something FROM somewhere'

    const mydb = {
      executeSql: async (text: string, values: []): Promise<{ rows: any[]; text: string }> => {
        assert.strictEqual(text, query)
        return { rows: [], text }
      }
    }

    const boss = new PgBoss({ db: mydb })
    const response = await boss.getDb().executeSql(query)

    // @ts-ignore
    assert(response.text === query)
  })
})
