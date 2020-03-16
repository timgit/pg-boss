const assert = require('assert')
const helper = require('./testHelper')

describe('connect', function () {
  it('should fail if connecting to an older schema version', async function () {
    const { schema } = this.test.bossConfig
    const boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })
    await boss.stop()

    const db = await helper.getDb()

    await db.executeSql(`UPDATE ${schema}.version SET VERSION = 2`)

    try {
      await boss.connect()
    } catch (error) {
      assert.notStrictEqual(error, null)
    }
  })

  it('should succeed if already started', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })
    await boss.connect()
    await boss.disconnect()
  })
})
