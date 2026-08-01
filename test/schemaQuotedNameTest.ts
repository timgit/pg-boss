import { expect } from 'vitest'
import * as Attorney from '../src/attorney.ts'
import * as plans from '../src/plans.ts'
import { normalizeSchemaName, resolveSchemaName } from '../src/tools.ts'
import { PgBoss } from '../src/index.ts'
import * as helper from './testHelper.ts'

const connectionString = 'postgres://localhost/db'

const getSchema = (schema: string) => Attorney.getConfig({ connectionString, schema }).schema

describe('quoted schema names', function () {
  describe('validation of bare names', function () {
    it('accepts the names it always accepted', function () {
      for (const schema of ['pgboss', 'pgboss_v2', 'MySchema', '_private']) {
        expect(getSchema(schema)).toBe(schema)
      }
    })

    it('still rejects bare names that are not legal identifiers', function () {
      expect(() => getSchema('my-schema')).toThrow('alphanumeric')
      expect(() => getSchema('1schema')).toThrow('cannot start with a number')
    })
  })

  describe('validation of quoted names', function () {
    it('accepts quoted names that are not legal bare', function () {
      for (const schema of ['"my-schema"', '"My-Schema"', '"user"', '"1schema"', '"schéma"', '"a b"']) {
        expect(getSchema(schema)).toBe(schema)
      }
    })

    it('rejects a double quote inside the outer pair', function () {
      // This is the injection vector: an inner quote closes the identifier early.
      expect(() => getSchema('"a"; DROP SCHEMA public CASCADE; --"'))
        .toThrow('cannot contain double quotes')
    })

    it('rejects characters that break the positions the name is interpolated into', function () {
      expect(() => getSchema('"o\'brien"')).toThrow('single quotes')
      expect(() => getSchema('"a$$b"')).toThrow('dollar signs')
      expect(() => getSchema('"x.job"')).toThrow('periods')
      expect(() => getSchema('"a\\b"')).toThrow('backslashes')
      expect(() => getSchema('"a\nb"')).toThrow('control characters')
    })

    it('rejects percent signs, which are format() specifiers', function () {
      // An unknown specifier aborts the statement outright...
      expect(() => getSchema('"pct%Schema"')).toThrow('percent signs')
      // ...and a valid one is worse: it shifts every later format() argument by one.
      expect(() => getSchema('"a%Ib"')).toThrow('percent signs')
    })

    it('applies the length limit to the resolved name', function () {
      expect(() => getSchema(`"${'a'.repeat(50)}"`)).not.toThrow()
      expect(() => getSchema(`"${'a'.repeat(51)}"`)).toThrow('cannot exceed 50')
    })

    it('measures the length limit in bytes, as postgres does', function () {
      // Postgres truncates identifiers past 63 bytes silently, which would desync the configured
      // name from the stored one and make every nspname comparison miss. 30 of these are 90 bytes.
      expect(() => getSchema(`"${'数'.repeat(30)}"`)).toThrow('cannot exceed 50 bytes')
      expect(() => getSchema(`"${'数'.repeat(16)}"`)).not.toThrow()
    })

    it('rejects an empty quoted name', function () {
      expect(() => getSchema('""')).toThrow('cannot be empty')
    })
  })

  describe('resolveSchemaName', function () {
    it('folds a bare name the way postgres does', function () {
      expect(resolveSchemaName('pgboss')).toBe('pgboss')
      expect(resolveSchemaName('MySchema')).toBe('myschema')
    })

    it('returns the contents of a quoted name verbatim', function () {
      expect(resolveSchemaName('"My-Schema"')).toBe('My-Schema')
      expect(resolveSchemaName('"user"')).toBe('user')
    })

    it('collapses redundant quoting onto the same resolved name', function () {
      // "pgboss" and pgboss are one schema, so they must share a notify channel and lock.
      expect(resolveSchemaName('"pgboss"')).toBe(resolveSchemaName('pgboss'))
    })

    it('keeps load-bearing quoting distinct', function () {
      // MySchema is stored as myschema, so it is a different schema from "MySchema".
      expect(resolveSchemaName('"MySchema"')).not.toBe(resolveSchemaName('MySchema'))
    })
  })

  describe('normalizeSchemaName', function () {
    it('strips quoting that carries no meaning', function () {
      expect(normalizeSchemaName('"pgboss"')).toBe('pgboss')
      expect(normalizeSchemaName('"pgboss_v2"')).toBe('pgboss_v2')
    })

    it('strips quoting from a reserved word', function () {
      // The quotes are load-bearing in identifier positions, but not here: a schema named `user`
      // resolves the same either way, so both spellings must land on one channel and one lock.
      expect(normalizeSchemaName('"user"')).toBe('user')
    })

    it('leaves bare names exactly as configured', function () {
      // Not folded to lower case: these values feed hashes, so folding would change the notify
      // channel and advisory lock key of a name that has always been legal, and split a rolling
      // upgrade across two channels.
      expect(normalizeSchemaName('pgboss')).toBe('pgboss')
      expect(normalizeSchemaName('MySchema')).toBe('MySchema')
    })

    it('leaves quoting in place when it changes which schema is meant', function () {
      // "MySchema" is a different schema from MySchema, which postgres stores as myschema, so the
      // two must not collapse onto the same channel and lock.
      expect(normalizeSchemaName('"MySchema"')).toBe('"MySchema"')
      expect(normalizeSchemaName('"My-Schema"')).toBe('"My-Schema"')
      expect(normalizeSchemaName('"a b"')).toBe('"a b"')
    })
  })

  describe('generated sql', function () {
    it('is unchanged for a name needing no quotes', function () {
      expect(plans.create('pgboss', 37, { createSchema: true })).not.toContain('"pgboss"')
    })

    it('compares against the resolved name in catalog lookups', function () {
      const sql = plans.create('"My-Schema"', 37, { createSchema: true })

      expect(sql).toContain("nspname = 'My-Schema'")
      expect(sql).not.toContain('nspname = \'"My-Schema"\'')
    })

    it('derives the same advisory lock for redundantly quoted names', function () {
      expect(plans.locked('"pgboss"', 'SELECT 1')).toEqual(plans.locked('pgboss', 'SELECT 1'))
    })

    it('derives a different advisory lock for load-bearing quoted names', function () {
      expect(plans.locked('"MySchema"', 'SELECT 1')).not.toEqual(plans.locked('MySchema', 'SELECT 1'))
    })

    it('derives the channel and lock from the name exactly as configured', function () {
      // These are hashes, never matched against the catalog, so they only have to agree between
      // instances. Folding a bare name into them would change the channel and lock key of an
      // install that has always been legal, and a rolling upgrade would stop coordinating.
      for (const schema of ['pgboss', 'MySchema']) {
        expect(plans.notifyChannelSql(schema)).toContain(`sha224('${schema}'::bytea)`)
        expect(plans.locked(schema, 'SELECT 1')).toContain(`.pgboss.${schema}`)
      }
    })
  })

  describe('runtime behaviour', function () {
    it('runs a full job lifecycle in a quoted schema', async function () {
      const schema = '"pg-boss Test-Schema"'
      const queue = 'quoted-schema-queue'

      await helper.dropSchema(schema)

      const boss = new PgBoss(helper.getConfig({ schema }))

      try {
        await boss.start()
        await boss.createQueue(queue)

        const jobId = await boss.send(queue, { hello: 'world' })
        expect(jobId).toBeTruthy()

        const [job] = await boss.fetch(queue)
        expect(job.data).toEqual({ hello: 'world' })

        await boss.complete(queue, job.id)
        expect((await boss.getJobById(queue, job.id))?.state).toBe('completed')
      } finally {
        await boss.stop({ graceful: false })
        await helper.dropSchema(schema)
      }
    })

    it('maintains queue stats partitions for a mixed case bare schema', async function () {
      // Pre-existing: nspname compared the configured name against the resolved one, so this
      // threw on every run for a schema postgres had folded to lower case.
      const schema = 'MixedCaseSchema'

      await helper.dropSchema(schema)

      const boss = new PgBoss(helper.getConfig({ schema }))

      try {
        await boss.start()
        await boss.createQueue('stats-partition-queue')
      } finally {
        await boss.stop({ graceful: false })
        await helper.dropSchema(schema)
      }
    })
  })
})
