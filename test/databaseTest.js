const delay = require('delay')
const pMap = require('p-map')
const assert = require('assert')
const PgBoss = require('../')
const helper = require('./testHelper')

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

  it('connection count does not exceed configured pool size', async function () {
    this.retries(1)

    const listenerCount = 100
    const poolSize = 5

    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, max: poolSize })

    const newConnections = await poolSizeConnectionTest(boss, listenerCount)

    assert(newConnections <= poolSize)
  })

  async function poolSizeConnectionTest (boss, listenerCount) {
    const listeners = []

    for (let x = 0; x < listenerCount; x++) {
      listeners[x] = x
    }

    const prevConnectionCount = await countConnections(boss.db)

    await pMap(listeners, (val, index) => boss.subscribe(`job${index}`, () => {}))

    await delay(3000)

    const connectionCount = await countConnections(boss.db)

    const newConnections = connectionCount - prevConnectionCount

    return newConnections

    async function countConnections (db) {
      const sql = 'SELECT count(*) as connections FROM pg_stat_activity WHERE application_name=$1'
      const values = [boss.db.config.application_name]

      const result = await db.executeSql(sql, values)

      return parseFloat(result.rows[0].connections)
    }
  }
})
