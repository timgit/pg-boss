import {
  getQueue,
  getJobs,
  getJobCountFromQueue,
  getQueueStatsCollectionStatus,
  isDeadLetterQueue,
  getSubscriptionEventCount,
} from './queries.server'
import { PAGE_SIZE, pageWindow, pageInfo } from './pagination'
import { isValidJobState, DEFAULT_STATE_FILTER } from './utils'
import { DEFAULT_QUEUE_JOB_COLUMNS, parseJobColumns } from './job-columns'

/**
 * What a queue's page shows: the queue, one page of its jobs, and what its header and banners need.
 * Apart from the route so an overlay that replaces the page can load it too. Throws a 404 response
 * when there is no such queue.
 */
export async function loadQueuePage (DB_URL: string, SCHEMA: string, name: string, request: Request) {
  const url = new URL(request.url)
  const stateParam = url.searchParams.get('state')
  const jobColumns = parseJobColumns(url.searchParams, DEFAULT_QUEUE_JOB_COLUMNS)

  // Default to 'pending' filter to avoid showing completed/failed jobs in large queues
  // Users can explicitly select 'all' to see all jobs
  const stateFilter = stateParam !== null && isValidJobState(stateParam)
    ? stateParam
    : DEFAULT_STATE_FILTER

  const { page, limit, offset } = pageWindow(url, PAGE_SIZE)

  const queue = await getQueue(DB_URL, SCHEMA, name)

  if (!queue) {
    throw new Response('Queue not found', { status: 404 })
  }

  // The Ready sparkline comes from the always-on queue.ready_history column (loaded with `queue`).
  // collection drives the banner that points at the interactive metrics chart (needs persistQueueStats).
  const [jobs, collection, isDeadLetter, subscribedEvents] = await Promise.all([
    getJobs(DB_URL, SCHEMA, name, { state: stateFilter, limit, offset, jobColumns }),
    getQueueStatsCollectionStatus(DB_URL, SCHEMA),
    isDeadLetterQueue(DB_URL, SCHEMA, name),
    getSubscriptionEventCount(DB_URL, SCHEMA, name),
  ])

  // Use cached count from queue table instead of COUNT(*) query
  // Returns null if count not available for this filter
  const totalCount = getJobCountFromQueue(queue, stateFilter)

  // The cached count lags the table, so it never decides which pages exist; a full page means
  // there may be another.
  const { hasNextPage, hasPrevPage } = pageInfo(page, PAGE_SIZE, jobs.length, null)

  return {
    queue,
    jobs,
    totalCount,
    page,
    stateFilter,
    jobColumns,
    hasNextPage,
    hasPrevPage,
    statsAvailable: collection.available,
    isDeadLetter,
    subscribedEvents,
  }
}

export type QueuePageData = Awaited<ReturnType<typeof loadQueuePage>>
