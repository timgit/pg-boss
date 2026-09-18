import { describe, it, expect } from 'vitest'
import { RouterContextProvider } from 'react-router'
import { ctx } from './helpers'
import { dbContext } from '~/lib/db-context'
import { capabilityContext } from '~/lib/capability-context'
import { CAPABILITIES, DEFAULT_DENIAL, defaultCapabilities } from '~/lib/capabilities'
import { loader as rootLoader } from '~/root'

// A loader's return value is serialized into the HTML for hydration, so
// anything it returns is readable by anyone who can load the page. These
// connection strings carry passwords.
const PASSWORD = 'hunter2-should-never-reach-the-browser'

function contextWith (databases: Array<{ id: string, name: string, url: string, schema: string }>) {
  const provider = new RouterContextProvider()

  provider.set(dbContext, {
    databases,
    currentDb: databases[0],
    DB_URL: databases[0].url,
    SCHEMA: databases[0].schema,
  })

  return provider
}

const primary = {
  id: 'primary',
  name: 'Production',
  url: `postgres://admin:${PASSWORD}@db.internal:5432/app`,
  schema: 'pgboss',
}

const secondary = {
  id: 'secondary',
  name: 'Staging',
  url: `postgres://admin:${PASSWORD}@stage.internal:5432/app`,
  schema: 'jobs',
}

async function load (databases = [primary, secondary]) {
  return rootLoader({
    request: new Request('http://localhost/'),
    context: contextWith(databases),
    params: {},
  } as Parameters<typeof rootLoader>[0])
}

describe('root loader', () => {
  it('publishes capabilities so the UI can hide mutating controls', async () => {
    const original = process.env.PGBOSS_DASHBOARD_READ_ONLY

    try {
      delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      const writable = (await load()).can
      expect(CAPABILITIES.every((capability) => writable[capability] === true)).toBe(true)

      process.env.PGBOSS_DASHBOARD_READ_ONLY = '1'
      const readOnly = (await load()).can
      expect(CAPABILITIES.every((capability) => readOnly[capability] === false)).toBe(true)
    } finally {
      if (original === undefined) {
        delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      } else {
        process.env.PGBOSS_DASHBOARD_READ_ONLY = original
      }
    }
  })

  /**
   * The seam the Pro overlay uses: whatever it set in `loadContext` is what the
   * browser is told, and the free dashboard's own answer is not merged into it.
   * A role that permits less has to be able to permit less.
   */
  it('lets an overlay replace the capabilities and the denial wording', async () => {
    const provider = new RouterContextProvider()

    provider.set(dbContext, {
      databases: [primary],
      currentDb: primary,
      DB_URL: primary.url,
      SCHEMA: primary.schema,
    })

    provider.set(capabilityContext, {
      capabilities: { 'job:retry': true },
      denial: { title: 'Not permitted', detail: 'Your role does not include this.' },
    })

    const data = await rootLoader({
      request: new Request('http://localhost/'),
      context: provider,
      params: {},
    } as Parameters<typeof rootLoader>[0])

    expect(data.can).toEqual({ 'job:retry': true })
    expect(data.can['job:delete']).toBeUndefined()
    expect(data.denial.title).toBe('Not permitted')
  })

  it('never sends a connection string to the browser', async () => {
    const data = await load()

    expect(JSON.stringify(data)).not.toContain(PASSWORD)
    expect(JSON.stringify(data)).not.toContain('postgres://')
  })

  it('sends only the fields the sidebar renders', async () => {
    const { databases, currentDb } = await load()

    for (const db of [...databases, currentDb]) {
      expect(Object.keys(db).sort()).toEqual(['id', 'name', 'schema'])
    }
  })

  it('keeps the schema, which the database selector displays', async () => {
    const { databases } = await load()

    expect(databases.map((db) => db.schema)).toEqual(['pgboss', 'jobs'])
  })

  it('preserves identity and order so the selector still works', async () => {
    const { databases, currentDb } = await load()

    expect(databases.map((db) => db.id)).toEqual(['primary', 'secondary'])
    expect(databases.map((db) => db.name)).toEqual(['Production', 'Staging'])
    expect(currentDb).toEqual({ id: 'primary', name: 'Production', schema: 'pgboss' })
  })

  it('tolerates a missing current database rather than throwing', async () => {
    const provider = new RouterContextProvider()

    provider.set(dbContext, {
      databases: [],
      currentDb: undefined as never,
      DB_URL: ctx.connectionString,
      SCHEMA: ctx.schema,
    })

    const data = await rootLoader({
      request: new Request('http://localhost/'),
      context: provider,
      params: {},
    } as Parameters<typeof rootLoader>[0])

    expect(data).toEqual({
      databases: [],
      currentDb: undefined,
      can: defaultCapabilities(false),
      denial: DEFAULT_DENIAL,
    })
  })
})
