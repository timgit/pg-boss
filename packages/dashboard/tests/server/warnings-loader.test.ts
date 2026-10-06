import { describe, it, expect } from 'vitest'
import { ctx, makeContext, insertTestWarning } from './helpers'
import { loader } from '~/routes/warnings'

async function load (search = '') {
  return loader({
    request: new Request(`http://localhost/warnings${search}`),
    context: makeContext(ctx),
    params: {},
  } as Parameters<typeof loader>[0])
}

describe('warnings loader', () => {
  it('pages by Previous and Next without counting the warning table', async () => {
    for (let i = 0; i < 51; i++) await insertTestWarning(ctx.schema, 'slow_query', `Warning ${i}`)

    const first = await load()
    expect(first.warnings).toHaveLength(50)
    expect([first.hasPrevPage, first.hasNextPage]).toEqual([false, true])
    expect(first).not.toHaveProperty('totalCount')
    expect(first.totalPages).toBeNull()

    const second = await load('?page=2')
    expect(second.warnings).toHaveLength(1)
    expect([second.hasPrevPage, second.hasNextPage]).toEqual([true, false])
  })
})
