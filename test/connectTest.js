const assert = require('chai').assert
const helper = require('./testHelper')

describe('connect', function () {
  this.timeout(10000)

  let boss

  beforeEach(async function () { boss = await helper.start() })
  after(async function () { await boss.stop() })

  it('should fail if connecting to an older schema version', async function () {
    const schema = helper.getConfig().schema

    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.version SET VERSION = '0.0.0'`)

    try {
      await boss.connect()
    } catch (error) {
      assert.isNotNull(error)
    }
  })

  it('should succeed if already started', async function () {
    await boss.connect()
    await boss.disconnect()
  })
})
