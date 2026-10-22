import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseAllowedActionOrigins, parseDatabaseConfig, toDatabaseConfig } from '~/lib/config.server'

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

describe('parseAllowedActionOrigins', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('is undefined when unset or blank', () => {
    delete process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS
    expect(parseAllowedActionOrigins()).toBeUndefined()

    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = ' , '
    expect(parseAllowedActionOrigins()).toBeUndefined()
  })

  it('splits a comma-separated host list', () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'admin.example.com, *.internal.example.com,**.example.org,localhost:8443'

    expect(parseAllowedActionOrigins()).toEqual(['admin.example.com', '*.internal.example.com', '**.example.org', 'localhost:8443'])
  })

  it('lowercases entries and drops default ports, as browsers do in Origin', () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'Admin.Example.com:443,admin.example.com:80,admin.example.com:8443'

    expect(parseAllowedActionOrigins()).toEqual(['admin.example.com', 'admin.example.com', 'admin.example.com:8443'])
  })

  it('rejects an entry that is not a bare host, which would never match', () => {
    for (const entry of ['https://admin.example.com', 'admin.example.com/pgboss', 'admin example.com', 'user@admin.example.com']) {
      process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = entry

      expect(() => parseAllowedActionOrigins()).toThrow(`"${entry}" is not a host`)
    }
  })

  it('rejects a wildcard that would allow any host', () => {
    for (const entry of ['*', '**', '*.com', '**.*', '*:8443']) {
      process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = entry

      expect(() => parseAllowedActionOrigins()).toThrow(`"${entry}" matches too many hosts`)
    }
  })

  it('rejects ** after the first label, which never matches', () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'admin.**.example.com'

    expect(() => parseAllowedActionOrigins()).toThrow('only allowed as the first label')
  })
})
