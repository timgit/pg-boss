const assert = require('assert')
const PgBoss = require('../')
const helper = require('./testHelper')

describe('config', function () {
  it('should allow a 50 character custom schema name', async function () {
    this.test.bossConfig.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    const boss = new PgBoss(this.test.bossConfig)

    await boss.start()
    await boss.stop()
  })

  it('should not allow a 51 character custom schema name', function () {
    this.test.bossConfig.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'
    assert.throws(() => new PgBoss(this.test.bossConfig))
  })

  it('should accept a connectionString property', async function () {
    const connectionString = helper.getConnectionString()
    const boss = new PgBoss({ connectionString, schema: this.test.bossConfig.schema })

    await boss.start()
    await boss.stop()
  })

  it('set pool config `poolSize`', async function () {
    const poolSize = 4
    const boss = await helper.start({ ...this.test.bossConfig, poolSize })

    assert(boss.db.config.poolSize === poolSize)
    assert(boss.db.pool.options.max === poolSize)

    await boss.stop()
  })

  it('set pool config `max`: `poolSize` === `max`', async function () {
    const max = 4
    const boss = await helper.start({ ...this.test.bossConfig, max })

    assert(boss.db.config.max === boss.db.config.poolSize)
    assert(boss.db.config.max === max)
    assert(boss.db.config.poolSize === max)
    assert(boss.db.pool.options.max === max)

    await boss.stop()
  })
})
