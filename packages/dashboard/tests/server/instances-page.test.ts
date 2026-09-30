import { describe, it, expect } from 'vitest'
import pg from 'pg'
import { ctx, getBoss, makeContext } from './helpers'
import { loader } from '~/routes/instances'

async function loadInstances () {
  return loader({
    params: {},
    context: makeContext(ctx),
    request: new Request('http://localhost/instances'),
  } as Parameters<typeof loader>[0])
}

async function sql (text: string) {
  const client = new pg.Client({ connectionString: ctx.connectionString })
  await client.connect()
  try {
    await client.query(text)
  } finally {
    await client.end()
  }
}

describe('/instances loader', () => {
  it('reads the registry as core does, with the database clock', async () => {
    const boss = getBoss()
    await boss.createQueue('instances-q')
    const [expected] = await boss.getInstances()

    const data = await loadInstances()

    expect(data.available).toBe(true)
    expect(data.checkedOn).toBeInstanceOf(Date)
    expect(data.instances).toHaveLength(1)
    expect(data.instances[0]).toEqual(expected)
    expect(data.instances[0]).toMatchObject({ live: true, supervise: false, schedule: false, stoppedOn: null })
  })

  it('reads an instance that missed three heartbeats as not live', async () => {
    await sql(`UPDATE ${ctx.schema}.instance SET heartbeat_on = heartbeat_on - heartbeat_seconds * 4 * interval '1 second'`)

    const data = await loadInstances()

    expect(data.instances.map((i) => i.live)).toEqual([false])
  })

  it('says the registry is unavailable on a schema that predates it', async () => {
    await sql(`DROP TABLE ${ctx.schema}.instance`)

    const data = await loadInstances()

    expect(data).toMatchObject({ available: false, instances: [] })
  })
})
