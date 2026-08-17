import { describe, it, expect } from './harness.ts'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { getConfig } from '../src/attorney.ts'
import { qn, qi, prefixQualify, POSTGRES, SQLITE } from '../src/dialect.ts'

// tableIsolation selects how bun-boss namespaces its tables: a real Postgres schema ('schema',
// the default) or a single quoted-name prefix in the default schema ('prefix', always used by
// SQLite and opt-in on Postgres).

describe('tableIsolation', function () {
  describe('config resolution', function () {
    it('defaults to schema mode with the pgboss namespace', function () {
      const config = getConfig({ url: 'postgres://localhost/db' })
      expect(config.tableIsolation).toBe('schema')
      expect(config.schema).toBe('pgboss')
      expect(config.noTablePartitioning).toBe(false)
      expect(config.createSchema).toBe(true)
    })

    it('defaults the prefix-mode namespace to bunboss and disables schema/partitioning', function () {
      const config = getConfig({ url: 'postgres://localhost/db', tableIsolation: 'prefix' })
      expect(config.tableIsolation).toBe('prefix')
      expect(config.schema).toBe('bunboss')
      expect(config.noTablePartitioning).toBe(true)
      expect(config.createSchema).toBe(false)
    })

    it('keeps an explicit schema name in prefix mode', function () {
      const config = getConfig({ url: 'postgres://localhost/db', tableIsolation: 'prefix', schema: 'myapp' })
      expect(config.schema).toBe('myapp')
    })

    it('forces prefix mode with the bunboss default for sqlite', function () {
      const config = getConfig({ backend: 'sqlite', db: {} as any })
      expect(config.tableIsolation).toBe('prefix')
      expect(config.schema).toBe('bunboss')
    })

    it('rejects tableIsolation schema on sqlite', function () {
      expect(() => getConfig({ backend: 'sqlite', db: {} as any, tableIsolation: 'schema' as any }))
        .toThrow(/sqlite.*always uses tableIsolation/)
    })

    it('rejects an unknown tableIsolation value', function () {
      expect(() => getConfig({ url: 'postgres://localhost/db', tableIsolation: 'bogus' as any }))
        .toThrow(/tableIsolation must be one of/)
    })
  })

  describe('name rendering', function () {
    it('renders a real schema qualification in schema mode', function () {
      expect(qn({ schema: 'myapp' }, 'job')).toBe('myapp.job')
      expect(qi({ schema: 'myapp' }, 'job_i1')).toBe('job_i1')
      expect(qn('myapp', 'job')).toBe('myapp.job')
    })

    it('renders a quoted-name prefix in prefix mode on any dialect', function () {
      const pg = { schema: 'myapp', tableIsolation: 'prefix' as const, dialect: POSTGRES }
      expect(qn(pg, 'job')).toBe('"myapp.job"')
      expect(qi(pg, 'job_i1')).toBe('"myapp.job_i1"')

      const sqlite = { schema: 'myapp', tableIsolation: 'prefix' as const, dialect: SQLITE }
      expect(qn(sqlite, 'job')).toBe('"myapp.job"')
    })

    it('resolves quoting and case like postgres storage', function () {
      expect(prefixQualify('"MySchema"', 'job')).toBe('"MySchema.job"')
      expect(prefixQualify('MySchema', 'job')).toBe('"myschema.job"')
    })
  })

  describe('installation', function () {
    // Prefix mode is a real dialect only for Postgres/PGlite here; SQLite exercises it in every test.
    helper.describePostgresOnly('on postgres', function () {
      it('installs prefixed tables in the default schema without creating a schema', async function () {
        ctx.boss = await helper.start({ ...ctx.bossConfig, tableIsolation: 'prefix' })

        const db = await helper.getDb()
        try {
          const prefixed = await db.executeSql(`SELECT to_regclass('"${ctx.schema}.job"') AS name`)
          expect(prefixed.rows[0].name).toBeTruthy()

          const namespace = await db.executeSql(`SELECT 1 FROM pg_namespace WHERE nspname = '${ctx.schema}'`)
          expect(namespace.rows.length).toBe(0)
        } finally {
          await db.close()
        }
      })

      it('round-trips a job through send, fetch, and complete', async function () {
        ctx.boss = await helper.start({ ...ctx.bossConfig, tableIsolation: 'prefix' })

        const message = 'prefixed'
        await ctx.boss.send({ name: ctx.schema, data: { message } })

        const [job] = await ctx.boss.fetch<{ message: string }>(ctx.schema)
        expect(job.data.message).toBe(message)

        await ctx.boss.complete(ctx.schema, job.id)

        const completed = await ctx.boss.getJobById(ctx.schema, job.id)
        expect(completed?.state).toBe('completed')
      })
    })
  })
})
