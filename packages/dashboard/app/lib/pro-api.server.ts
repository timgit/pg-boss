/**
 * The dashboard's `.server` modules Pro imports. See `pro-api.ts` for the rule.
 */

export type { SchemaConfig } from '~/lib/config.server'
export { closeAllPools, getQueryTimeoutMs, onClose, query } from '~/lib/db.server'
export { loadInstancePage, loadInstances } from '~/lib/instances.server'
export { loadOverview } from '~/lib/overview.server'
export { publishedJobsHref, publishFailure } from '~/lib/publish.server'
export {
  getInstanceRegistry,
  getJobById,
  getLatencyWindows,
  getQueueNames,
  getQueuePage,
  getQueueStatsCollectionStatus,
  getQueueStatsHistory,
  getQueueThroughput,
  getSubscription,
  getThroughputOverview,
  getTopQueues,
  hasLatencyColumns,
  resolveAggregate,
} from '~/lib/queries.server'
export { loadQueueList, QUEUE_PAGE_SIZE } from '~/lib/queue-list.server'
export { loadQueuePage } from '~/lib/queue-page.server'
