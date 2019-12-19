const assert = require('chai').assert
const PgBoss = require('../src/index')
const helper = require('./testHelper')

describe('initialization', function () {
  this.timeout(10000)

  beforeEach(() => helper.init())

  it('should fail if connecting to an uninitialized instance', async function () {
    try {
      const config = helper.getConfig()
      new PgBoss(config).connect()
    } catch (error) {
      assert.isNotNull(error)
    }
  })

  it('should start with a connection string', async function () {
    const connectionString = helper.getConnectionString()
    const boss = new PgBoss(connectionString)
    await boss.start()
    await boss.stop()
  })
})
