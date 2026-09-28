import type { Route } from './+types/stats._index'
import {
  getQueueNames,
  getQueueStatsCollectionStatus,
  getThroughputOverview,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import {
  STATS_INTERVALS,
  fillBuckets,
  parseStatsInterval,
  settledPerMin,
  statsWindows,
  sumSeries,
  windowAverage,
} from '~/lib/stats'
import { ErrorCard } from '~/components/error-card'
import { PageHeader } from '~/components/ui/page-header'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'
import { StatsIntervalSwitch } from '~/components/stats-interval-switch'
import { StatsRateCard } from '~/components/stats-rate-card'
import { ThroughputPanel } from '~/components/throughput-panel'

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const interval = parseStatsInterval(new URL(request.url).searchParams.get('interval'))
  const { bucketSeconds, previous, current } = statsWindows(interval)
  const span = { from: previous.from, to: current.to }

  // One query for every queue: the per-queue series and, summed, the all-queues one.
  const [names, series, collection] = await Promise.all([
    getQueueNames(DB_URL, SCHEMA),
    getThroughputOverview(DB_URL, SCHEMA, { ...span, bucketSeconds }),
    getQueueStatsCollectionStatus(DB_URL, SCHEMA),
  ])

  const points = fillBuckets(sumSeries(series), span, bucketSeconds)
  const arrived = (p: typeof points[number]) => p.arrivedPerMin

  return {
    interval,
    queueCount: names.length,
    statsAvailable: collection.available,
    points,
    range: [span.from.getTime() / 1000, span.to.getTime() / 1000] as [number, number],
    bucketSeconds,
    arrived: { current: windowAverage(points, current, arrived), previous: windowAverage(points, previous, arrived) },
    finishing: { current: windowAverage(points, current, settledPerMin), previous: windowAverage(points, previous, settledPerMin) },
  }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return (
    <ErrorCard
      title="Failed to load queue stats"
      error={error}
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function StatsPage ({ loaderData }: Route.ComponentProps) {
  const { interval, queueCount, statsAvailable, points, range, bucketSeconds, arrived, finishing } = loaderData
  const { noun } = STATS_INTERVALS[interval]
  const counted = arrived.current != null || arrived.previous != null

  return (
    <div className="space-y-4">
      <PageHeader
        title="Queue stats"
        subtitle={`Work arriving and finishing across ${queueCount === 1 ? 'the one queue' : `all ${queueCount.toLocaleString('en-US')} queues`}, compared with the previous ${noun}`}
        action={<StatsIntervalSwitch interval={interval} />}
      />

      {!statsAvailable && <StatsDisabledBanner />}

      {statsAvailable && !counted && (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          No throughput counted in the last {(2 * STATS_INTERVALS[interval].seconds) / 3600} hours. pg-boss
          12.35 and later count it on each monitor pass, with <code className="font-mono text-[0.9em]">persistQueueStats</code> on.
        </p>
      )}

      <section aria-label="Key figures, all queues" className="grid gap-4 sm:grid-cols-2">
        <StatsRateCard
          label="Arrival rate, all queues"
          color="var(--stats-arrived)"
          current={arrived.current}
          previous={arrived.previous}
          tone="neutral"
          noun={noun}
          series={points.map((p) => p.arrivedPerMin)}
        />
        <StatsRateCard
          label="Finishing rate, all queues"
          color="var(--stats-finishing)"
          current={finishing.current}
          previous={finishing.previous}
          tone="higher-is-better"
          noun={noun}
          series={points.map(settledPerMin)}
        />
      </section>

      {statsAvailable && (
        <ThroughputPanel title="Throughput, all queues" points={points} noun={noun} range={range} bucketSeconds={bucketSeconds} />
      )}
    </div>
  )
}
