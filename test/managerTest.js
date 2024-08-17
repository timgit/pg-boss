const { delay } = require('../src/tools')
const assert = require('assert')
const helper = require('./testHelper')

describe('manager', function () {
  it('should reject multiple simultaneous start requests', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    await boss.start()

    await delay(2000)

    try {
      await boss.start()
      assert(false)
    } catch (error) {
      assert(true)
    }
  })
})
