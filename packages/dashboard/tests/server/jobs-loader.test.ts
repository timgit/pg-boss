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
  it('pages by Previous and Next, offering Next after a full page', async () => {
    await send(21)

    const first = await load()
    expect(first.recentJobs).toHaveLength(20)
    expect([first.hasPrevPage, first.hasNextPage]).toEqual([false, true])

    const second = await load('?page=2')
    expect(second.recentJobs).toHaveLength(1)
    expect([second.hasPrevPage, second.hasNextPage]).toEqual([true, false])
  })

  it('offers Next after an exactly full last page, which then comes back empty', async () => {
    await send(20)

    expect((await load('?queues=paged')).hasNextPage).toBe(true)
    const after = await load('?queues=paged&page=2')
    expect(after.recentJobs).toHaveLength(0)
    expect([after.hasPrevPage, after.hasNextPage]).toEqual([true, false])
  })

  it('returns no count of the job table, filtered or not', async () => {
    await send(1)

    for (const data of [await load(), await load('?state=failed&queues=paged')]) {
      expect(data).not.toHaveProperty('totalCount')
      expect(data).not.toHaveProperty('totalPages')
    }
  })
})
