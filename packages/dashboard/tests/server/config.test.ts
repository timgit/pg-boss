import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseDatabaseConfig, parseSiteUrl, toDatabaseConfig } from '~/lib/config.server'

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
    expect(toDatabaseConfig({ url: 'postgres://host/' }, 1).name).toBe('Database 2')
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

  it('reads named and unnamed databases with their schemas', () => {
    process.env.DATABASE_URL = 'Prod=postgres://user:p=ss@host/a|postgres://host/b'
    process.env.PGBOSS_SCHEMA = 'one|two'

    expect(parseDatabaseConfig()).toEqual([
      { id: 'prod', name: 'Prod', url: 'postgres://user:p=ss@host/a', schema: 'one' },
      { id: 'b', name: 'b', url: 'postgres://host/b', schema: 'two' },
    ])
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
