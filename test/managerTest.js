const Promise = require('bluebird')
const assert = require('chai').assert
const helper = require('./testHelper')
const PgBoss = require('../src/index')

describe('manager', function () {
  this.timeout(10000)

  before(() => helper.init())

  it('should reject multiple simultaneous start requests', async function () {
    const boss = new PgBoss(helper.getConfig())

    await boss.start()

    await Promise.delay(2000)

    try {
      await boss.start()
      assert(false)
    } catch (error) {
      boss.stop()
    }
  })
})
