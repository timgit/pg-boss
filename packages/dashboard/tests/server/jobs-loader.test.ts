import { describe, it, expect } from 'vitest'
import { ctx, makeContext, createTestQueue, sendTestJob } from './helpers'
import { loader } from '~/routes/jobs'

async function load (search = '') {
  return loader({
    request: new Request(`http://localhost/jobs${search}`),
    context: makeContext(ctx),
    params: {},
  } as Parameters<typeof loader>[0])
}

async function send (n: number) {
  await createTestQueue('paged')
  for (let i = 0; i < n; i++) await sendTestJob('paged', { i })
}

describe('jobs loader', () => {
  it('pages by Previous and Next, past the last job of the page before', async () => {
    await send(21)

    const first = await load()
    expect(first.recentJobs).toHaveLength(20)
    expect([first.hasPrevPage, first.hasNextPage]).toEqual([false, true])

    const second = await load(`?after=${first.nextCursor}&page=2`)
    expect(second.recentJobs).toHaveLength(1)
    expect([second.hasPrevPage, second.hasNextPage]).toEqual([true, false])
  })

  it('offers no Next after an exactly full last page, since a page reads one job past its end', async () => {
    await send(20)

    const only = await load('?queues=paged')
    expect(only.recentJobs).toHaveLength(20)
    expect([only.hasPrevPage, only.hasNextPage]).toEqual([false, false])
  })

  it('returns no count of the job table, filtered or not', async () => {
    await send(1)

    for (const data of [await load(), await load('?state=failed&queues=paged')]) {
      expect(data).not.toHaveProperty('totalCount')
      expect(data).not.toHaveProperty('totalPages')
    }
  })
})
