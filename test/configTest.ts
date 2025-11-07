import assert from 'node:assert'
import Db from '../src/db.ts'
import { PgBoss } from '../src/index.ts'
import * as helper from './testHelper.ts'
import packageJson from '../package.json' with { type: 'json' }

describe('config', function () {
  it('should allow a 50 character custom schema name', async function () {
    const config = this.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    await helper.dropSchema(config.schema)

    assert.strictEqual(config.schema.length, 50)

    this.boss = new PgBoss(config)

    await this.boss.start()

    await helper.dropSchema(config.schema)
  })

  it('should not allow more than 50 characters in schema name', async function () {
    const config = this.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'

    await helper.dropSchema(config.schema)

    assert(config.schema.length > 50)

    assert.throws(() => new PgBoss(config))
  })

  it('should accept a connectionString property', async function () {
    const connectionString = helper.getConnectionString()
    this.boss = new PgBoss({ connectionString, schema: this.bossConfig.schema })

    await this.boss.start()
  })

  it('should not allow calling job instance functions if not started', async function () {
    const boss = new PgBoss(this.bossConfig)

    assert.rejects(async () => {
      await boss.send('queue1')
    })
  })

  it('start() should return instance after', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss
    const result2 = await this.boss.start()
    assert(result2)
  })

  it('isInstalled() should indicate whether db schema is installed', async function () {
    const db = new Db(this.bossConfig)
    await db.open()

    this.boss = new PgBoss({ ...this.bossConfig, db })
    assert.strictEqual(await this.boss.isInstalled(), false)
    await this.boss.start()
    assert.strictEqual(await this.boss.isInstalled(), true)
  })

  it('schemaVersion() should return current version', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss
    const version = await this.boss.schemaVersion()
    assert.strictEqual(version, packageJson.pgboss.schema)
  })
})
