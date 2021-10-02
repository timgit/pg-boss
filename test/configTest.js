const assert = require('assert')
const PgBoss = require('../')
const helper = require('./testHelper')

describe('config', function () {
  it('should allow a 50 character custom schema name', async function () {
    const config = this.test.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    await helper.dropSchema(config.schema)

    assert.strictEqual(config.schema.length, 50)

    const boss = this.test.boss = new PgBoss(config)

    await boss.start()
  })

  it('should not allow more than 50 characters in schema name', async function () {
    const config = this.test.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'

    await helper.dropSchema(config.schema)

    assert(config.schema.length > 50)

    assert.throws(() => new PgBoss(config))
  })

  it('should accept a connectionString property', async function () {
    const connectionString = helper.getConnectionString()
    const boss = this.test.boss = new PgBoss({ connectionString, schema: this.test.bossConfig.schema })

    await boss.start()
  })

  it('should not allow calling job instance functions if not started', async function () {
    const boss = new PgBoss(this.test.bossConfig)
    try {
      await boss.publish('queue1')
      assert(false)
    } catch {}
  })

  it.skip('start() should fail if pgcrypto is not available', async function () {
    const database = 'pgboss_test1'

    await helper.createDb(database)

    const config = { ...this.test.bossConfig, database }

    const boss = new PgBoss(config)

    try {
      await boss.start()
      assert(false, 'Error should have been thrown by missing pgcrypto extension')
    } catch (err) {
      assert(err.message.includes('gen_random_uuid()'))
    }

    await helper.tryDropDb(database)
  })
})
