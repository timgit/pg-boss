const assert = require('assert')
const PgBoss = require('../')
const Db = require('../src/db')

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

  describe('Db.quotePostgresStr', function () {
    it('should dollar-sign quote specified input', async function () {
      const str = Db.quotePostgresStr('Here\'s my input')
      assert(str === '$sanitize$Here\'s my input$sanitize$')
    })

    it('should error if input contains reserved quote delimiter', async function () {
      const badInput = '$sanitize$; DROP TABLE job --'
      try {
        Db.quotePostgresStr(badInput)
        assert(false, 'Error was expected but did not occur')
      } catch (err) {
        assert(err.message === `Attempted to quote string that contains reserved Postgres delimeter: ${badInput}`)
      }
    })
  })
})
