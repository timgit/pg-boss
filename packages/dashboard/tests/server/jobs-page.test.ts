import { describe, it, expect } from 'vitest'
import { ctx, createTestQueue, sendTestJob, makeContext, getBoss } from './helpers'
import { loader } from '~/routes/jobs'
import { pagingSearchParams } from '~/lib/utils'

async function loadJobs (params: URLSearchParams | string = '') {
  return loader({
    params: {},
    context: makeContext(ctx),
    request: new Request(`http://localhost/jobs?${params.toString()}`),
  } as Parameters<typeof loader>[0])
}

type Loaded = Awaited<ReturnType<typeof loadJobs>>

// Follow the page's Next or Previous button, as the route component does.
function step (from: Loaded, current: URLSearchParams, newPage: number) {
  return pagingSearchParams(current, newPage, from)
}

describe('jobs loader paging', () => {
  it('shows a next page only when a row follows the page', async () => {
    await createTestQueue('test-queue')
    for (let i = 0; i < 20; i++) await sendTestJob('test-queue', { i })

    const full = await loadJobs()
    expect(full.recentJobs).toHaveLength(20)
    expect(full.hasNextPage).toBe(false)

    await sendTestJob('test-queue', { i: 20 })
    const first = await loadJobs()
    expect(first.recentJobs).toHaveLength(20)
    expect(first.hasNextPage).toBe(true)
    expect(first.hasPrevPage).toBe(false)

    const secondParams = step(first, new URLSearchParams(), 2)
    const second = await loadJobs(secondParams)
    expect(second.page).toBe(2)
    expect(second.recentJobs).toHaveLength(1)
    expect(second.hasNextPage).toBe(false)
    expect(second.hasPrevPage).toBe(true)

    const seen = new Set([...first.recentJobs, ...second.recentJobs].map(j => j.id))
    expect(seen.size).toBe(21)
  })

  it('pages forward and back through jobs that share created_on', async () => {
    await createTestQueue('alpha')
    await createTestQueue('beta')
    // One insert() per queue: every job of a batch has the same created_on.
    await getBoss().insert('alpha', Array.from({ length: 30 }, (_, i) => ({ data: { i } })))
    await getBoss().insert('beta', Array.from({ length: 25 }, (_, i) => ({ data: { i } })))

    const pages: Loaded[] = []
    let params = new URLSearchParams()
    let page = await loadJobs(params)
    pages.push(page)
    while (page.hasNextPage) {
      params = step(page, params, page.page + 1)
      page = await loadJobs(params)
      pages.push(page)
    }

    const ids = pages.flatMap(p => p.recentJobs.map(j => `${j.name}/${j.id}`))
    expect(ids).toHaveLength(55)
    expect(new Set(ids).size).toBe(55)
    expect(pages.map(p => p.page)).toEqual([1, 2, 3])

    const back = await loadJobs(step(page, params, 2))
    expect(back.page).toBe(2)
    expect(back.recentJobs.map(j => j.id)).toEqual(pages[1].recentJobs.map(j => j.id))
  })

  it('continues past a boundary job deleted since the page was read', async () => {
    await createTestQueue('test-queue')
    for (let i = 0; i < 25; i++) await sendTestJob('test-queue', { i })

    const first = await loadJobs()
    const last = first.recentJobs.at(-1)!
    await getBoss().deleteJob('test-queue', last.id)

    const second = await loadJobs(step(first, new URLSearchParams(), 2))
    expect(second.recentJobs).toHaveLength(5)
    expect(second.recentJobs.map(j => j.id)).not.toContain(last.id)
  })

  it('treats a mangled cursor as the first page', async () => {
    await createTestQueue('test-queue')
    await sendTestJob('test-queue', { i: 0 })

    const data = await loadJobs('after=not-a-cursor&page=4')
    expect(data.page).toBe(1)
    expect(data.recentJobs).toHaveLength(1)
  })
})
