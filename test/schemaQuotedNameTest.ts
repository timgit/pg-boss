import { expect } from 'vitest'
import * as Attorney from '../src/attorney.ts'
import * as plans from '../src/plans.ts'
import { resolveSchemaName } from '../src/tools.ts'
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

    it('applies the length limit to the resolved name', function () {
      expect(() => getSchema(`"${'a'.repeat(50)}"`)).not.toThrow()
      expect(() => getSchema(`"${'a'.repeat(51)}"`)).toThrow('cannot exceed 50')
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
