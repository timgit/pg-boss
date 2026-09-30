import {
  getWarnings,
  getQueueStats,
  getTopQueues,
  getQueueCount,
  getProblemQueuesCount,
  getBamStatusSummary,
} from './queries.server'

/**
 * What the overview shows: the stat row, the async migrations in flight, the busiest queues and the
 * latest warnings. Apart from the route so a Pro overview that replaces the page can load it too.
 */
export async function loadOverview (DB_URL: string, SCHEMA: string) {
  const [warnings, stats, topQueues, totalQueues, problemQueuesCount, bamSummary] = await Promise.all([
    getWarnings(DB_URL, SCHEMA, { limit: 5 }),
    getQueueStats(DB_URL, SCHEMA),
    getTopQueues(DB_URL, SCHEMA, 5),
    getQueueCount(DB_URL, SCHEMA),
    getProblemQueuesCount(DB_URL, SCHEMA),
    getBamStatusSummary(DB_URL, SCHEMA),
  ])

  // Reduce the BAM summary to the counts the overview card needs.
  const migrations = bamSummary.reduce(
    (acc, row) => {
      if (row.status === 'pending') acc.pending += row.count
      else if (row.status === 'in_progress') acc.inProgress += row.count
      else if (row.status === 'failed') acc.failed += row.count
      return acc
    },
    { pending: 0, inProgress: 0, failed: 0 }
  )

  return {
    stats,
    warnings,
    topQueues,
    migrations,
    queueStats: {
      totalQueues,
      problemQueues: problemQueuesCount,
    },
  }
}

export type OverviewData = Awaited<ReturnType<typeof loadOverview>>
