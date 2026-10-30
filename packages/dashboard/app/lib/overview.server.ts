import {
  getWarnings,
  getQueueStats,
  getTopQueues,
  getQueueCount,
  getProblemQueuesCount,
  getBamStatusSummary,
} from './queries.server'
import { loadInstances } from './instances.server'
import { instanceSummary, type InstanceSummary } from './instances'

/**
 * What the overview shows: the stat row, the async migrations in flight, the busiest queues and the
 * latest warnings. Apart from the route so a Pro overview that replaces the page can load it too.
 * `warnings: false` and `instances: false` skip those reads, for an overview that leaves the card out.
 */
export async function loadOverview (DB_URL: string, SCHEMA: string, options: { warnings?: boolean, instances?: boolean } = {}) {
  const [warnings, registry, stats, topQueues, totalQueues, problemQueuesCount, bamSummary] = await Promise.all([
    options.warnings === false ? null : getWarnings(DB_URL, SCHEMA, { limit: 5 }),
    options.instances === false ? null : loadInstances(DB_URL, SCHEMA).catch(() => null),
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

  // Null when skipped; a null summary when the schema predates the registry.
  const instances: { summary: InstanceSummary | null } | null = options.instances === false
    ? null
    : { summary: registry?.available ? instanceSummary(registry.instances, registry.connections) : null }

  return {
    stats,
    warnings: warnings?.rows ?? null,
    instances,
    topQueues,
    migrations,
    queueStats: {
      totalQueues,
      problemQueues: problemQueuesCount,
    },
  }
}

export type OverviewData = Awaited<ReturnType<typeof loadOverview>>
