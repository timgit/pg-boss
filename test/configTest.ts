import assert from 'node:assert'
import Db from '../src/db.ts'
import { PgBoss } from '../src/index.ts'
import * as helper from './testHelper.ts'
import packageJson from '../package.json' with { type: 'json' }
import { testContext } from './hooks.ts'

describe('config', function () {
  it('should allow a 50 character custom schema name', async function () {
    const config = testContext.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    await helper.dropSchema(config.schema)

    assert.strictEqual(config.schema.length, 50)

    testContext.boss = new PgBoss(config)

    await testContext.boss.start()

    await helper.dropSchema(config.schema)
  })

  it('should not allow more than 50 characters in schema name', async function () {
    const config = testContext.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'

    await helper.dropSchema(config.schema)

    assert(config.schema.length > 50)

    assert.throws(() => new PgBoss(config))
  })

  it('should accept a connectionString property', async function () {
    const connectionString = helper.getConnectionString()
    testContext.boss = new PgBoss({ connectionString, schema: testContext.bossConfig.schema })

    await testContext.boss.start()
  })

  it('should not allow calling job instance functions if not started', async function () {
    const boss = new PgBoss(testContext.bossConfig)

    await assert.rejects(async () => {
      await boss.send('queue1')
    })
  })

  it('start() should return instance after', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const result2 = await testContext.boss.start()
    assert(result2)
  })

  it('isInstalled() should indicate whether db schema is installed', async function () {
    const db = new Db(testContext.bossConfig)
    await db.open()

    testContext.boss = new PgBoss({ ...testContext.bossConfig, db })
    assert.strictEqual(await testContext.boss.isInstalled(), false)
    await testContext.boss.start()
    assert.strictEqual(await testContext.boss.isInstalled(), true)
  })

  it('schemaVersion() should return current version', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const version = await testContext.boss.schemaVersion()
    assert.strictEqual(version, packageJson.pgboss.schema)
  })
})
