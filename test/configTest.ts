import { expect } from 'vitest'
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

    expect(config.schema.length).toBe(50)

    testContext.boss = new PgBoss(config)

    await testContext.boss.start()

    await helper.dropSchema(config.schema)
  })

  it('should not allow more than 50 characters in schema name', async function () {
    const config = testContext.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'

    await helper.dropSchema(config.schema)

    expect(config.schema.length > 50).toBeTruthy()

    expect(() => new PgBoss(config)).toThrow()
  })

  it('should accept a connectionString property', async function () {
    const connectionString = helper.getConnectionString()
    testContext.boss = new PgBoss({ connectionString, schema: testContext.bossConfig.schema })

    await testContext.boss.start()
  })

  it('should not allow calling job instance functions if not started', async function () {
    const boss = new PgBoss(testContext.bossConfig)

    await expect(async () => {
      await boss.send('queue1')
    }).rejects.toThrow()
  })

  it('start() should return instance after', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const result2 = await testContext.boss.start()
    expect(result2).toBeTruthy()
  })

  it('isInstalled() should indicate whether db schema is installed', async function () {
    const db = new Db(testContext.bossConfig)
    await db.open()

    testContext.boss = new PgBoss({ ...testContext.bossConfig, db })
    expect(await testContext.boss.isInstalled()).toBe(false)
    await testContext.boss.start()
    expect(await testContext.boss.isInstalled()).toBe(true)
  })

  it('schemaVersion() should return current version', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    const version = await testContext.boss.schemaVersion()
    expect(version).toBe(packageJson.pgboss.schema)
  })
})
