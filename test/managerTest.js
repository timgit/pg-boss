const delay = require('delay')
const assert = require('assert')
const PgBoss = require('../')

describe('manager', function () {
  it('should reject multiple simultaneous start requests', async function () {
    const boss = new PgBoss(this.test.bossConfig)

    await boss.start()

    await delay(2000)

    try {
      await boss.start()
      assert(false)
    } catch (error) {
      await boss.stop()
    }
  })
})
