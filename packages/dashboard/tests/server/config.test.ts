import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseDatabaseConfig, toDatabaseConfig } from '~/lib/config.server'

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
