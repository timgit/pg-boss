const assert = require('assert')
const PgBoss = require('../')

describe('database', function () {
  it('should fail on invalid database host', async function () {
    const boss = new PgBoss('postgres://bobby:tables@wat:12345/northwind')

    try {
      await boss.start()
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('can be swapped out via BYODB', async function () {
    const query = 'SELECT something FROM somewhere'

    const mydb = {
      executeSql: async (text, values) => ({ rows: [], text, rowCount: 0 })
    }

    const boss = new PgBoss({ db: mydb })
    const response = await boss.db.executeSql(query)

    assert(response.text === query)
  })
})
