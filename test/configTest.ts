import { expect } from 'vitest'
import Db from '../src/db.ts'
import { PgBoss } from '../src/index.ts'
import * as helper from './testHelper.ts'
import packageJson from '../package.json' with { type: 'json' }
import { ctx } from './hooks.ts'

describe('config', function () {
  it('should allow a 50 character custom schema name', async function () {
    const config = ctx.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    await helper.dropSchema(config.schema)

    expect(config.schema.length).toBe(50)

    ctx.boss = new PgBoss(config)

    await ctx.boss.start()

    await helper.dropSchema(config.schema)
  })

  it('should not allow more than 50 characters in schema name', async function () {
    const config = ctx.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'

    await helper.dropSchema(config.schema)

    expect(config.schema.length > 50).toBeTruthy()

    expect(() => new PgBoss(config)).toThrow()
  })

  it('should accept a connectionString property', async function () {
    const connectionString = helper.getConnectionString()
    ctx.boss = new PgBoss({ connectionString, schema: ctx.bossConfig.schema })

    await ctx.boss.start()
  })

  it('should not allow calling job instance functions if not started', async function () {
    const boss = new PgBoss(ctx.bossConfig)

    await expect(async () => {
      await boss.send('queue1')
    }).rejects.toThrow()
  })

  it('start() should return instance after', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const result2 = await ctx.boss.start()
    expect(result2).toBeTruthy()
  })

  it('isInstalled() should indicate whether db schema is installed', async function () {
    const db = new Db(ctx.bossConfig)
    await db.open()

    ctx.boss = new PgBoss({ ...ctx.bossConfig, db })
    expect(await ctx.boss.isInstalled()).toBe(false)
    await ctx.boss.start()
    expect(await ctx.boss.isInstalled()).toBe(true)
  })

  it('schemaVersion() should return current version', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const version = await ctx.boss.schemaVersion()
    expect(version).toBe(packageJson.pgboss.schema)
  })
})
