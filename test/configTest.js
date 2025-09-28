import assert, { strictEqual, throws } from 'node:assert'
import PgBoss from '../src/index.js'
import { dropSchema, getConnectionString, start } from './testHelper.js'

describe('config', () => {
  it('should allow a 50 character custom schema name', async function () {
    const config = this.test.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    await dropSchema(config.schema)

    strictEqual(config.schema.length, 50)

    const boss = (this.test.boss = new PgBoss(config))

    await boss.start()

    await dropSchema(config.schema)
  })

  it('should not allow more than 50 characters in schema name', async function () {
    const config = this.test.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'

    await dropSchema(config.schema)

    assert(config.schema.length > 50)

    throws(() => new PgBoss(config))
  })

  it('should accept a connectionString property', async function () {
    const connectionString = getConnectionString()
    const boss = (this.test.boss = new PgBoss({
      connectionString,
      schema: this.test.bossConfig.schema
    }))

    await boss.start()
  })

  it('should not allow calling job instance functions if not started', async function () {
    const boss = new PgBoss(this.test.bossConfig)
    try {
      await boss.send('queue1')
      assert(false)
    } catch {}
  })

  it('start() should return instance after', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const result2 = await boss.start()
    assert(result2)
  })
})
