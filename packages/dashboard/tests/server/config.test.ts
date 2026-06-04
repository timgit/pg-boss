import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfigFile, buildConnectionConfig } from '~/lib/config.server'

describe('loadConfigFile', () => {
  const dirs: string[] = []

  function writeConfig (contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'pgboss-dashboard-config-'))
    dirs.push(dir)
    const path = join(dir, 'config.mjs')
    writeFileSync(path, contents)
    return path
  }

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  })

  it('loads database entries with connection options', async () => {
    const path = writeConfig(`
      export default [
        {
          name: 'Production',
          url: 'postgres://user@host:5432/proddb',
          schema: 'jobs',
          options: {
            password: () => 'generated-token',
            ssl: { rejectUnauthorized: false },
          },
        },
        {
          url: 'postgres://user@host:5432/stagedb',
        },
      ]
    `)

    const configs = await loadConfigFile(path)

    expect(configs).toHaveLength(2)
    expect(configs[0]).toMatchObject({
      id: 'production',
      name: 'Production',
      url: 'postgres://user@host:5432/proddb',
      schema: 'jobs',
    })
    expect(typeof (configs[0].options as any).password).toBe('function')
    expect((configs[0].options as any).password()).toBe('generated-token')
    expect((configs[0].options as any).ssl).toEqual({ rejectUnauthorized: false })

    // Name derived from database, schema defaulted, no options
    expect(configs[1]).toMatchObject({
      name: 'stagedb',
      schema: 'pgboss',
    })
    expect(configs[1].options).toBeUndefined()
  })

  it('rejects a module that does not export an array', async () => {
    const path = writeConfig('export default { url: "postgres://host/db" }')
    await expect(loadConfigFile(path)).rejects.toThrow(/non-empty array/)
  })

  it('rejects entries without a url', async () => {
    const path = writeConfig('export default [{ name: "broken" }]')
    await expect(loadConfigFile(path)).rejects.toThrow(/missing a "url"/)
  })

  it('rejects an unreadable module path', async () => {
    await expect(loadConfigFile('/nonexistent/config.mjs')).rejects.toThrow(/Failed to load/)
  })
})

describe('buildConnectionConfig', () => {
  it('passes the url through when there are no options', () => {
    expect(buildConnectionConfig('postgres://host/db')).toEqual({
      connectionString: 'postgres://host/db',
    })
  })

  it('parses the url into discrete fields when options are present', () => {
    // node-postgres ignores a password function next to connectionString,
    // so options force the discrete-field form
    const password = () => 'token'
    const config = buildConnectionConfig('postgres://user:unused@host:5433/db', { password })

    expect(config).toMatchObject({
      host: 'host',
      port: 5433,
      database: 'db',
      user: 'user',
      password,
    })
    expect(config.connectionString).toBeUndefined()
  })

  it('lets options override fields parsed from the url', () => {
    const config = buildConnectionConfig('postgres://user@host:5432/db', { user: 'other' })
    expect(config.user).toBe('other')
  })
})
