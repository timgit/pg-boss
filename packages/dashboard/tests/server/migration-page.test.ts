import { describe, it, expect } from 'vitest'
import { ctx, makeContext, insertTestBam } from './helpers'
import { loader } from '~/routes/migrations.$id'

const load = (id: string) => loader({
  params: { id },
  context: makeContext(ctx),
  request: new Request(`http://localhost/migrations/${id}`),
} as Parameters<typeof loader>[0])

describe('/migrations/:id loader', () => {
  it('reads one migration with its command and error', async () => {
    const id = await insertTestBam(ctx.schema, { name: 'job_i9', version: 45, status: 'failed', queue: 'billing', error: 'canceling statement due to lock timeout' })

    const { entry } = await load(id)

    expect(entry).toMatchObject({ id, name: 'job_i9', version: 45, status: 'failed', queue: 'billing', table: 'job_common', error: 'canceling statement due to lock timeout' })
    expect(entry.command).toContain('CREATE INDEX CONCURRENTLY job_i9')
  })

  it('is not found for an unknown id, or one that is not a uuid', async () => {
    await expect(load('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 })
    await expect(load('nope')).rejects.toMatchObject({ status: 404 })
  })
})
