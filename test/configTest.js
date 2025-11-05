import assert from 'node:assert'
import Db from '../src/db.ts'
import PgBoss from '../src/index.ts'
import * as helper from './testHelper.js'
import packageJson from '../package.json' with { type: 'json' }

describe('config', function () {
  it('should allow a 50 character custom schema name', async function () {
    const config = this.test.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    await helper.dropSchema(config.schema)

    assert.strictEqual(config.schema.length, 50)

    const boss = this.test.boss = new PgBoss(config)

    await boss.start()

    await helper.dropSchema(config.schema)
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
      await boss.send('queue1')
      assert(false)
    } catch {}
  })

  it('start() should return instance after', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const result2 = await boss.start()
    assert(result2)
  })

  it('isInstalled() should indicate whether db schema is installed', async function () {
    const db = new Db(this.test.bossConfig)
    await db.open()

    const boss = this.test.boss = new PgBoss({ ...this.test.bossConfig, db })
    assert.strictEqual(await boss.isInstalled(), false)
    await boss.start()
    assert.strictEqual(await boss.isInstalled(), true)
  })

  it('schemaVersion() should return current version', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const version = await boss.schemaVersion()
    assert.strictEqual(version, packageJson.pgboss.schema)
  })
})
