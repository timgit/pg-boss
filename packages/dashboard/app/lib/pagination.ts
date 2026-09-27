import { parsePageNumber } from './utils'

export interface PageWindow {
  page: number
  limit: number
  offset: number
}

export interface PageInfo {
  page: number
  totalPages: number | null
  hasNextPage: boolean
  hasPrevPage: boolean
}

/** The page a list request asks for, as the `page` search param says, and the rows it covers. */
export function pageWindow (params: URLSearchParams | URL, pageSize: number): PageWindow {
  const search = params instanceof URL ? params.searchParams : params
  const page = parsePageNumber(search.get('page'))

  return { page, limit: pageSize, offset: (page - 1) * pageSize }
}

/**
 * Where a page sits among the rest. With a known count the answer is exact; without one (null),
 * a full page is taken to mean there may be another.
 */
export function pageInfo (page: number, pageSize: number, rows: number, totalCount: number | null): PageInfo {
  return {
    page,
    totalPages: totalCount != null ? Math.ceil(totalCount / pageSize) : null,
    hasNextPage: totalCount != null ? page * pageSize < totalCount : rows === pageSize,
    hasPrevPage: page > 1,
  }
}
