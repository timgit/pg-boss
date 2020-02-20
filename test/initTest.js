const assert = require('assert')
const PgBoss = require('../')

describe('init', function () {
  it('should fail if connecting to an uninitialized instance', async function () {
    try {
      await new PgBoss(this.test.bossConfig).connect()
    } catch (error) {
      assert(error)
    }
  })
})
