import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { normalizeAllowedActionOrigins, parseAllowedActionOrigins, parseDatabaseConfig, toDatabaseConfig } from '~/lib/config.server'

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

  it('lowercases entries, and allows a default port with and without it', () => {
    process.env.PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS = 'Admin.Example.com:443,admin.example.com:80,admin.example.com:8443'

    expect(parseAllowedActionOrigins()).toEqual(['admin.example.com', 'admin.example.com:443', 'admin.example.com:80', 'admin.example.com:8443'])
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
})

describe('normalizeAllowedActionOrigins', () => {
  const normalize = (entry: string) => normalizeAllowedActionOrigins([entry], 'allowedActionOrigins')

  it('names the setting in the error', () => {
    expect(() => normalize('**')).toThrow('allowedActionOrigins entry "**" matches too many hosts')
  })

  it('stores the host form browsers send in Origin', () => {
    expect(normalizeAllowedActionOrigins(['bücher.example', '*.Bücher.example', '[0:0::1]:8080', '127.1'], 'x'))
      .toEqual(['xn--bcher-kva.example', '*.xn--bcher-kva.example', '[::1]:8080', '127.0.0.1'])
  })

  it('returns its own output unchanged', () => {
    const hosts = normalizeAllowedActionOrigins(['Admin.Example.com:443', '*.example.org'], 'x')

    expect(normalizeAllowedActionOrigins(hosts, 'x')).toEqual(hosts)
  })

  it('rejects a wildcard anywhere but the whole first label, which never matches as intended', () => {
    for (const entry of ['admin.**.example.com', 'example.com.*', '*.*.example.com', 'api-*.example.com']) {
      expect(() => normalize(entry)).toThrow('only as the whole first label')
    }
  })

  it('rejects an empty label, which never matches', () => {
    for (const entry of ['.example.com', 'example.com.', '*.example.com.', 'a..example.com']) {
      expect(() => normalize(entry)).toThrow('has an empty label')
    }
  })

  it('rejects a wildcard over a top-level domain, and names it', () => {
    expect(() => normalize('*.localhost')).toThrow('covers every host under .localhost')
  })

  it('rejects a wildcard over a domain whose subdomains belong to different owners', () => {
    for (const entry of ['*.co.uk', '**.co.uk', '*.com.au', '*.github.io', '**.vercel.app']) {
      expect(() => normalize(entry)).toThrow('belong to different owners')
    }
  })

  it('accepts a wildcard under a domain someone owns there', () => {
    expect(normalizeAllowedActionOrigins(['*.example.co.uk', '*.acme.github.io'], 'x'))
      .toEqual(['*.example.co.uk', '*.acme.github.io'])
  })

  it('rejects a wildcard in front of an IP address', () => {
    expect(() => normalize('*.127.0.0.1')).toThrow('in front of an IP address')
  })
})
