import { describe, it, expect } from 'vitest'
import { pageWindow, pageInfo } from '~/lib/pagination'

describe('pageWindow', () => {
  it('reads the page and turns it into rows', () => {
    expect(pageWindow(new URL('http://x/queues?page=3'), 50)).toEqual({ page: 3, limit: 50, offset: 100 })
    expect(pageWindow(new URLSearchParams('page=2'), 20)).toEqual({ page: 2, limit: 20, offset: 20 })
  })

  it('treats a missing or unusable page as the first', () => {
    for (const search of ['', 'page=0', 'page=-4', 'page=abc']) {
      expect(pageWindow(new URLSearchParams(search), 50)).toEqual({ page: 1, limit: 50, offset: 0 })
    }
  })
})

describe('pageInfo', () => {
  it('is exact with a count', () => {
    expect(pageInfo(1, 50, 50, 120)).toEqual({ page: 1, totalPages: 3, hasNextPage: true, hasPrevPage: false })
    expect(pageInfo(3, 50, 20, 120)).toEqual({ page: 3, totalPages: 3, hasNextPage: false, hasPrevPage: true })
  })

  // A last page that happens to be full has nothing after it, which only a count can tell.
  it('offers no next page after a full last page when the count is known', () => {
    expect(pageInfo(2, 50, 50, 100).hasNextPage).toBe(false)
  })

  it('takes a full page to mean there may be another when the count is unknown', () => {
    expect(pageInfo(2, 20, 20, null)).toEqual({ page: 2, totalPages: null, hasNextPage: true, hasPrevPage: true })
    expect(pageInfo(2, 20, 7, null).hasNextPage).toBe(false)
  })
})
