import { describe, it, expect } from 'vitest'
import { RouterContextProvider } from 'react-router'
import { ctx } from './helpers'
import { schemaContext } from '~/lib/schema-context'
import { loader as rootLoader } from '~/root'

// A loader's return value is serialized into the HTML for hydration, so
// anything it returns is readable by anyone who can load the page. These
// connection strings carry passwords.
const PASSWORD = 'hunter2-should-never-reach-the-browser'

function contextWith (schemas: Array<{ id: string, name: string, connection: { url: string, schema: string } }>) {
  const provider = new RouterContextProvider()

  provider.set(schemaContext, {
    schemas,
    currentSchema: schemas[0],
    connection: schemas[0].connection,
  })

  return provider
}

const primary = {
  id: 'primary',
  name: 'Production',
  connection: { url: `postgres://admin:${PASSWORD}@db.internal:5432/app`, schema: 'pgboss' },
}

const secondary = {
  id: 'secondary',
  name: 'Staging',
  connection: { url: `postgres://admin:${PASSWORD}@stage.internal:5432/app`, schema: 'jobs' },
}

async function load (schemas = [primary, secondary]) {
  return rootLoader({
    request: new Request('http://localhost/'),
    context: contextWith(schemas),
    params: {},
  } as Parameters<typeof rootLoader>[0])
}

describe('root loader', () => {
  it('never sends a connection string to the browser', async () => {
    const data = await load()

    expect(JSON.stringify(data)).not.toContain(PASSWORD)
    expect(JSON.stringify(data)).not.toContain('postgres://')
  })

  it('sends only the fields the sidebar renders', async () => {
    const { schemas, currentSchema } = await load()

    for (const schema of [...schemas, currentSchema]) {
      expect(Object.keys(schema).sort()).toEqual(['connection', 'id', 'name'])
      expect(Object.keys(schema.connection)).toEqual(['schema'])
    }
  })

  it('keeps the schema, which the database selector displays', async () => {
    const { schemas } = await load()

    expect(schemas.map((schema) => schema.connection.schema)).toEqual(['pgboss', 'jobs'])
  })

  it('preserves identity and order so the selector still works', async () => {
    const { schemas, currentSchema } = await load()

    expect(schemas.map((schema) => schema.id)).toEqual(['primary', 'secondary'])
    expect(schemas.map((schema) => schema.name)).toEqual(['Production', 'Staging'])
    expect(currentSchema).toEqual({ id: 'primary', name: 'Production', connection: { schema: 'pgboss' } })
  })

  it('tolerates a missing current database rather than throwing', async () => {
    const provider = new RouterContextProvider()

    provider.set(schemaContext, {
      schemas: [],
      currentSchema: undefined as never,
      connection: { url: ctx.connectionString, schema: ctx.schema },
    })

    const data = await rootLoader({
      request: new Request('http://localhost/'),
      context: provider,
      params: {},
    } as Parameters<typeof rootLoader>[0])

    expect(data).toEqual({
      schemas: [],
      internal: [],
      currentSchema: undefined,
      pgbossMissing: false,
      readOnly: false,
    })
  })

  it('says whether the dashboard is read-only, for the headers\' Send job', async () => {
    const original = process.env.PGBOSS_DASHBOARD_READ_ONLY
    const provider = new RouterContextProvider()
    provider.set(schemaContext, { schemas: [], currentSchema: undefined as never, connection: { url: ctx.connectionString, schema: ctx.schema } })
    const load = () => rootLoader({ request: new Request('http://localhost/'), context: provider, params: {} } as Parameters<typeof rootLoader>[0])

    try {
      process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'
      expect((await load()).readOnly).toBe(true)
    } finally {
      if (original === undefined) delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      else process.env.PGBOSS_DASHBOARD_READ_ONLY = original
    }
  })

  it('sends an overlay\'s own schemas apart from the databases, with their badge and never their connection string', async () => {
    const provider = contextWith([primary])
    provider.set(schemaContext, {
      ...provider.get(schemaContext),
      internal: [{ id: 'pro_queues', name: 'Pro queues', connection: { url: `postgres://admin:${PASSWORD}@db.internal:5432/app`, schema: 'pgboss_pro_queue' }, badge: 'Pro' }],
    })

    const data = await rootLoader({
      request: new Request('http://localhost/'),
      context: provider,
      params: {},
    } as Parameters<typeof rootLoader>[0])

    expect(data.schemas.map((schema) => schema.id)).toEqual(['primary'])
    expect(data.internal).toEqual([{ id: 'pro_queues', name: 'Pro queues', connection: { schema: 'pgboss_pro_queue' }, badge: 'Pro' }])
    expect(JSON.stringify(data)).not.toContain(PASSWORD)
  })
})
