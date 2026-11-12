import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseDatabaseConfig, parseSiteUrl, refuseSchemaVariable, takeSchema, toDatabaseConfig } from '~/lib/config.server'

describe('toDatabaseConfig', () => {
  it('names the database after the connection string and defaults the schema', () => {
    expect(toDatabaseConfig({ url: 'postgres://user:pass@host/orders' }, 0)).toEqual({
      id: 'orders',
      name: 'orders',
      url: 'postgres://user:pass@host/orders',
      schema: 'pgboss',
    })
  })

  it('keeps an explicit name and schema', () => {
    expect(toDatabaseConfig({ url: 'postgres://host/db', name: 'Main DB', schema: 'jobs' }, 0)).toEqual({
      id: 'main-db',
      name: 'Main DB',
      url: 'postgres://host/db',
      schema: 'jobs',
    })
  })

  it('falls back to a positional name when the connection string has no database', () => {
    expect(toDatabaseConfig({ url: 'postgres://host/' }, 1).name).toBe('Schema 2')
  })
})

describe('parseDatabaseConfig', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.PGBOSS_SCHEMA
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('reads named and unnamed entries with the schema on each connection string', () => {
    process.env.DATABASE_URL = 'Prod=postgres://user:p=ss@host/a?schema=one|postgres://host/b?sslmode=require&schema=two|postgres://host/c'

    expect(parseDatabaseConfig()).toEqual([
      { id: 'prod', name: 'Prod', url: 'postgres://user:p=ss@host/a', schema: 'one' },
      { id: 'b', name: 'b', url: 'postgres://host/b?sslmode=require', schema: 'two' },
      { id: 'c', name: 'c', url: 'postgres://host/c', schema: 'pgboss' },
    ])
  })

  it('ignores PGBOSS_SCHEMA, which createHonoApp refuses', () => {
    process.env.DATABASE_URL = 'postgres://host/a'
    process.env.PGBOSS_SCHEMA = 'jobs'

    expect(parseDatabaseConfig()[0].schema).toBe('pgboss')
  })

  it('tells apart two schemas in one database, keeping the first id as it was', () => {
    process.env.DATABASE_URL = 'postgres://host/app|postgres://host/app?schema=jobs|postgres://other/app?schema=jobs'

    expect(parseDatabaseConfig().map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'app', name: 'app' },
      { id: 'app-jobs', name: 'app (jobs)' },
      { id: 'app-jobs-3', name: 'app (jobs)' },
    ])
  })
})

describe('takeSchema', () => {
  it('takes schema out of the query and keeps the other parameters as written', () => {
    expect(takeSchema('postgres://h/db?schema=jobs')).toEqual({ url: 'postgres://h/db', schema: 'jobs' })
    expect(takeSchema('postgres://h/db?sslmode=require&schema=jobs&sslrootcert=/etc/ca.pem')).toEqual({
      url: 'postgres://h/db?sslmode=require&sslrootcert=/etc/ca.pem',
      schema: 'jobs',
    })
    expect(takeSchema('postgres://h/db?schema=my%5Fjobs')).toEqual({ url: 'postgres://h/db', schema: 'my_jobs' })
  })

  it('leaves a connection string without schema alone', () => {
    expect(takeSchema('postgres://h/db')).toEqual({ url: 'postgres://h/db' })
    expect(takeSchema('postgres://h/db?sslmode=require')).toEqual({ url: 'postgres://h/db?sslmode=require', schema: undefined })
  })

  it('treats an empty schema as unset', () => {
    expect(takeSchema('postgres://h/db?schema=')).toEqual({ url: 'postgres://h/db', schema: undefined })
  })
})

describe('refuseSchemaVariable', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('does nothing when PGBOSS_SCHEMA is unset or blank', () => {
    delete process.env.PGBOSS_SCHEMA
    expect(() => refuseSchemaVariable()).not.toThrow()
    process.env.PGBOSS_SCHEMA = ' '
    expect(() => refuseSchemaVariable()).not.toThrow()
  })

  it('stops with the new form, using the schema it was given', () => {
    process.env.PGBOSS_SCHEMA = 'orders'
    expect(() => refuseSchemaVariable()).toThrow("The dashboard doesn't read PGBOSS_SCHEMA. Unset it and name each schema on its connection string in DATABASE_URL, as in DATABASE_URL=postgres://host/db?schema=orders.")
  })

  it('stops on a pgboss value too, and on a list', () => {
    process.env.PGBOSS_SCHEMA = 'pgboss'
    expect(() => refuseSchemaVariable()).toThrow('?schema=pgboss.')
    process.env.PGBOSS_SCHEMA = 'one|two'
    expect(() => refuseSchemaVariable()).toThrow('?schema=jobs.')
  })
})

describe('parseSiteUrl', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('is undefined when unset or blank', () => {
    delete process.env.PGBOSS_DASHBOARD_SITE_URL
    expect(parseSiteUrl()).toBeUndefined()

    process.env.PGBOSS_DASHBOARD_SITE_URL = ' '
    expect(parseSiteUrl()).toBeUndefined()
  })

  it('returns the origin', () => {
    process.env.PGBOSS_DASHBOARD_SITE_URL = ' https://PgBoss.Example.com:443/ '
    expect(parseSiteUrl()).toBe('https://pgboss.example.com')

    process.env.PGBOSS_DASHBOARD_SITE_URL = 'http://localhost:8080'
    expect(parseSiteUrl()).toBe('http://localhost:8080')
  })

  it('rejects anything but http(s)://host[:port]', () => {
    for (const value of ['pgboss.example.com', 'localhost:3000', 'https://pgboss.example.com/pgboss', 'https://pgboss.example.com/?a=1', 'https://pgboss.example.com/#top', 'https://user:pw@pgboss.example.com', 'ws://pgboss.example.com']) {
      process.env.PGBOSS_DASHBOARD_SITE_URL = value

      expect(() => parseSiteUrl()).toThrow(`PGBOSS_DASHBOARD_SITE_URL "${value}" is not a site URL`)
    }
  })
})
