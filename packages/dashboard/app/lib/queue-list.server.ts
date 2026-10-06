import { getQueues, getQueueCount } from './queries.server'
import { pageWindow, pageInfo } from './pagination'
import { parseQueueView, QUEUE_VIEW_COOKIE, type QueueView } from './queue-list'

/** Queues per page. */
export const QUEUE_PAGE_SIZE = 50
/** The most queues `all` reads: an overlay ordering the whole list pages it itself. */
const ALL_LIMIT = 10_000

const FILTERS = ['all', 'attention', 'partitioned'] as const
export type QueueFilter = (typeof FILTERS)[number]

function cookieValue (request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/**
 * What `/queues` shows: one page of queues, and the filter, search and sort that chose them. Apart
 * from the route so an overlay that replaces the page can load it too. With `all`, every queue the
 * filter and search match comes back as one page, for an overlay with an order of its own to sort
 * and page itself. `views` are the ways an overlay offers to draw the list, in the order its toggle
 * shows them, and `defaultView` the one it opens on, the first unless named; without an overlay
 * there is only the table.
 */
export async function loadQueueList (
  DB_URL: string,
  SCHEMA: string,
  request: Request,
  { all = false, views = ['table'], defaultView }: { all?: boolean, views?: QueueView[], defaultView?: QueueView } = {}
) {
  const url = new URL(request.url)
  const { page, limit, offset } = all ? { page: 1, limit: ALL_LIMIT, offset: 0 } : pageWindow(url, QUEUE_PAGE_SIZE)
  const rawFilter = url.searchParams.get('filter') || 'all'
  const filter: QueueFilter = (FILTERS as readonly string[]).includes(rawFilter) ? rawFilter as QueueFilter : 'all'
  const search = url.searchParams.get('search') || ''
  const sort = url.searchParams.get('sort')
  const dir = url.searchParams.get('dir')
  // The URL wins, then the viewer's last choice, then the default.
  const view: QueueView = parseQueueView(url.searchParams.get('view') ?? cookieValue(request, QUEUE_VIEW_COOKIE), views, defaultView)

  // Most ready first unless the URL names a sort. A sort only an overlay knows falls back to name
  // here, and the overlay orders the page itself.
  const [queues, totalCount] = await Promise.all([
    getQueues(DB_URL, SCHEMA, { limit, offset, filter, search, sort: sort ?? 'ready', dir: sort ? dir : 'desc' }),
    getQueueCount(DB_URL, SCHEMA, { filter, search }),
  ])

  return {
    queues,
    totalCount,
    pageSize: all ? ALL_LIMIT : QUEUE_PAGE_SIZE,
    ...pageInfo(page, all ? ALL_LIMIT : QUEUE_PAGE_SIZE, queues.length, totalCount),
    filter,
    search,
    sort,
    dir,
    views,
    view,
  }
}

export type QueueListData = Awaited<ReturnType<typeof loadQueueList>>
