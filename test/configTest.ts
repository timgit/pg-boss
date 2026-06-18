import { expect } from 'vitest'
import Db from '../src/db.ts'
import { PgBoss } from '../src/index.ts'
import * as Attorney from '../src/attorney.ts'
import * as helper from './testHelper.ts'
import packageJson from '../package.json' with { type: 'json' }
import { ctx } from './hooks.ts'

describe('config', function () {
  describe('backend profiles', function () {
    const flags = ['distributedDatabaseMode', 'noTablePartitioning', 'noDeferrableConstraints', 'noAdvisoryLocks', 'noCoveringIndexes'] as const

    const trueFlags = (config: any) => flags.filter(f => config[f] === true)

    it('postgres (default) leaves all flags off', function () {
      const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db' })
      expect(resolved.backend).toBe('postgres')
      expect(trueFlags(resolved)).toEqual([])
    })

    it('cockroachdb enables distributed mode and all four no* gates', function () {
      const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db', backend: 'cockroachdb' })
      expect(trueFlags(resolved).sort()).toEqual([...flags].sort())
    })

    it('yugabytedb enables only noAdvisoryLocks + noTablePartitioning', function () {
      const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db', backend: 'yugabytedb' })
      expect(trueFlags(resolved).sort()).toEqual(['noAdvisoryLocks', 'noTablePartitioning'].sort())
    })

    it('citus and pglite leave all flags off', function () {
      for (const backend of ['citus', 'pglite'] as const) {
        const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db', backend })
        expect(trueFlags(resolved)).toEqual([])
      }
    })

    it('an explicit flag overrides the profile', function () {
      const resolved = Attorney.getConfig({ connectionString: 'postgres://localhost/db', backend: 'cockroachdb', noCoveringIndexes: false })
      expect(resolved.noCoveringIndexes).toBe(false)
      expect(resolved.distributedDatabaseMode).toBe(true)
    })

    it('rejects an unknown backend', function () {
      expect(() => Attorney.getConfig({ connectionString: 'postgres://localhost/db', backend: 'nope' as any })).toThrow('backend must be one of')
    })
  })

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

  it('should reject non-boolean distributed database flags', function () {
    const flags = [
      'distributedDatabaseMode',
      'noTablePartitioning',
      'noDeferrableConstraints',
      'noAdvisoryLocks',
      'noCoveringIndexes'
    ]

    for (const flag of flags) {
      expect(() => new PgBoss({ ...ctx.bossConfig, [flag]: 'yes' } as any)).toThrow(`${flag} must be a boolean`)
    }
  })

  it('should accept boolean distributed database flags', function () {
    const boss = new PgBoss({
      ...ctx.bossConfig,
      distributedDatabaseMode: true,
      noTablePartitioning: true,
      noDeferrableConstraints: true,
      noAdvisoryLocks: true,
      noCoveringIndexes: true
    })

    expect(boss).toBeTruthy()
  })

  it('should warn when YugabyteDB is detected without compatibility flags', async function () {
    const realDb = await helper.getDb()
    const warnings: any[] = []

    try {
      const boss = new PgBoss({
        ...ctx.bossConfig,
        db: {
          async executeSql (sql: string, values: any[]) {
            if (/^\s*SELECT version\(\)/i.test(sql)) {
              return { rows: [{ version: 'PostgreSQL 15.12-YB-2025.2.3.2-b0 on x86_64-pc-linux-gnu' }] }
            }
            return realDb.executeSql(sql, values)
          }
        }
      })

      boss.on('warning', (w: any) => warnings.push(w))

      await boss.start()
      await boss.stop({ close: false, graceful: false })

      const ybWarning = warnings.find(w => w.data?.backend === 'yugabytedb')
      expect(ybWarning).toBeTruthy()
      expect(ybWarning.message).toContain('noTablePartitioning')
      expect(ybWarning.message).toContain('noAdvisoryLocks')
    } finally {
      await realDb.close()
    }
  })

  it('should not warn about YugabyteDB when compatibility flags are set', async function () {
    const realDb = await helper.getDb()
    const warnings: any[] = []

    try {
      const boss = new PgBoss({
        ...ctx.bossConfig,
        noTablePartitioning: true,
        noAdvisoryLocks: true,
        db: {
          async executeSql (sql: string, values: any[]) {
            if (/^\s*SELECT version\(\)/i.test(sql)) {
              return { rows: [{ version: 'PostgreSQL 15.12-YB-2025.2.3.2-b0 on x86_64-pc-linux-gnu' }] }
            }
            return realDb.executeSql(sql, values)
          }
        }
      })

      boss.on('warning', (w: any) => warnings.push(w))

      await boss.start()
      await boss.stop({ close: false, graceful: false })

      expect(warnings.find(w => w.data?.backend === 'yugabytedb')).toBeUndefined()
    } finally {
      await realDb.close()
    }
  })

  helper.itPglite('should accept a connectionString property', async function () {
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

  it('should allow start() retry after a startup error', async function () {
    let calls = 0
    const db = {
      async executeSql () {
        calls += 1
        throw new Error('startup failed')
      }
    }
    const boss = new PgBoss({ db, migrate: false, supervise: false, schedule: false })

    await expect(boss.start()).rejects.toThrow('startup failed')
    const callsAfterFirst = calls

    await expect(boss.start()).rejects.toThrow('startup failed')

    // start() must re-attempt on retry (not get stuck), so the db is touched again
    expect(calls).toBeGreaterThan(callsAfterFirst)
  })

  helper.itPglite('isInstalled() should indicate whether db schema is installed', async function () {
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
