import { expect } from 'vitest'
import { BunBoss } from '../src/index.ts'

describe('database', function () {
  it('should fail on invalid database host', async function () {
    const boss = new BunBoss({
      connectionString: 'postgres://bobby:tables@wat:12345/northwind',
      connectionTimeoutMillis: 3000
    })

    await expect(async () => {
      await boss.start()
    }).rejects.toThrow()
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
})
