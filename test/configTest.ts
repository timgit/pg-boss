import { expect } from 'vitest'
import Db from '../src/db.ts'
import { BunBoss } from '../src/index.ts'
import * as Attorney from '../src/attorney.ts'
import * as helper from './testHelper.ts'
import packageJson from '../package.json' with { type: 'json' }
import { ctx } from './hooks.ts'

describe('config', function () {
  describe('backend profiles', function () {
    const flags = ['noSkipLocked', 'noMultiMutationCte', 'noTablePartitioning', 'noDeferrableConstraints', 'noAdvisoryLocks', 'noCoveringIndexes', 'noListenNotify'] as const

    const trueFlags = (config: any) => flags.filter(f => config[f] === true)

    it('postgres (default) leaves all flags off', function () {
      const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db' })
      expect(resolved.backend).toBe('postgres')
      expect(trueFlags(resolved)).toEqual([])
    })

    it('pglite leaves all flags off', function () {
      const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db', backend: 'pglite' })
      expect(trueFlags(resolved)).toEqual([])
    })

    it('sqlite enables every compatibility flag', function () {
      const resolved = Attorney.getConfig({ backend: 'sqlite', db: { executeSql: async () => ({ rows: [] }) } as any })
      expect(trueFlags(resolved).sort()).toEqual([...flags].sort())
    })

    it('rejects an unknown backend', function () {
      expect(() => Attorney.getConfig({ connectionString: 'postgres://localhost/db', backend: 'nope' as any })).toThrow('backend must be one of')
    })

    // The distributed-Postgres profiles were dropped; the seam that once produced these flags on
    // Postgres-rendered SQL is preserved through __test__ hooks so the branches stay testable.
    it('the __test__ hooks each force their flag on top of postgres', function () {
      const cases = {
        __test__distributed: ['noSkipLocked', 'noMultiMutationCte'],
        __test__noAdvisoryLocks: ['noAdvisoryLocks'],
        __test__noTablePartitioning: ['noTablePartitioning'],
        __test__noDeferrableConstraints: ['noDeferrableConstraints'],
        __test__noCoveringIndexes: ['noCoveringIndexes'],
        __test__noListenNotify: ['noListenNotify']
      } as const

      for (const [hook, expected] of Object.entries(cases)) {
        const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db', [hook]: true } as any)
        expect(trueFlags(resolved).sort()).toEqual([...expected].sort())
      }
    })
  })

  it('should allow a 50 character custom schema name', async function () {
    const config = ctx.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength'

    await helper.dropSchema(config.schema)

    expect(config.schema.length).toBe(50)

    ctx.boss = new BunBoss(config)

    await ctx.boss.start()

    await ctx.boss.stop()

    await helper.dropSchema(config.schema)
  })

  it('should not allow more than 50 characters in schema name', async function () {
    const config = ctx.bossConfig

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb'

    await helper.dropSchema(config.schema)

    expect(config.schema.length > 50).toBeTruthy()

    expect(() => new BunBoss(config)).toThrow()
  })

  it('compatibility flags are derived from the backend, not user-settable', function () {
    // The individual flags are internal; supplying them directly has no effect — only
    // `backend` determines them. (Passed through `as any` since they are not public options.)
    const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db', noSkipLocked: true, noTablePartitioning: true } as any)
    expect(resolved.backend).toBe('postgres')
    expect((resolved as any).noSkipLocked).toBe(false)
    expect((resolved as any).noTablePartitioning).toBe(false)
  })

  helper.itPglite('should accept a connectionString property', async function () {
    const connectionString = helper.getConnectionString()
    ctx.boss = new BunBoss({ connectionString, schema: ctx.bossConfig.schema })

    await ctx.boss.start()
  })

  it('should not allow calling job instance functions if not started', async function () {
    const boss = new BunBoss(ctx.bossConfig)

    await expect(async () => {
      await boss.send('queue1')
    }).rejects.toThrow()
  })

  it('start() should return instance after', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const result2 = await ctx.boss.start()
    expect(result2).toBeTruthy()
  })

  it('should allow start() retry after a startup error', async function () {
    let calls = 0
    const db = {
      async executeSql () {
        calls += 1
        throw new Error('startup failed')
      }
    }
    const boss = new BunBoss({ db, migrate: false, supervise: false, schedule: false })

    await expect(boss.start()).rejects.toThrow('startup failed')
    const callsAfterFirst = calls

    await expect(boss.start()).rejects.toThrow('startup failed')

    // start() must re-attempt on retry (not get stuck), so the db is touched again
    expect(calls).toBeGreaterThan(callsAfterFirst)
  })

  helper.itPglite('isInstalled() should indicate whether db schema is installed', async function () {
    const db = new Db(ctx.bossConfig)
    await db.open()

    ctx.boss = new BunBoss({ ...ctx.bossConfig, db })
    expect(await ctx.boss.isInstalled()).toBe(false)
    await ctx.boss.start()
    expect(await ctx.boss.isInstalled()).toBe(true)
  })

  it('schemaVersion() should return current version', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const version = await ctx.boss.schemaVersion()
    expect(version).toBe(packageJson.bunboss.schema)
  })
})
