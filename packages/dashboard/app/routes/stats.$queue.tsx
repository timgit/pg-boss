import { useSearchParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import type { Route } from './+types/stats.$queue'
import {
  getQueue,
  getQueueStatsHistory,
  getQueueThroughput,
  getQueueStatsCollectionStatus,
  resolveAggregate,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import {
  STATS_INTERVALS,
  fillBuckets,
  parseDepthSeries,
  parseStatsInterval,
  settledPerMin,
  statsWindows,
  windowAverage,
  type DepthSeriesKey,
} from '~/lib/stats'
import type { QueueStatsAggregate } from '~/lib/types'
import { DbLink } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { PageHeader } from '~/components/ui/page-header'
import { Button } from '~/components/ui/button'
import { StatsIntervalSwitch } from '~/components/stats-interval-switch'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'
import { StatsRateCard } from '~/components/stats-rate-card'
import { ThroughputPanel } from '~/components/throughput-panel'
import { DepthPanel } from '~/components/depth-panel'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import { cn } from '~/lib/utils'

export async function loader ({ params, request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const search = new URL(request.url).searchParams
  const interval = parseStatsInterval(search.get('interval'))
  const aggregate = resolveAggregate(search.get('agg'))
  const { bucketSeconds, previous, current } = statsWindows(interval)
  const span = { from: previous.from, to: current.to }

  const queue = await getQueue(DB_URL, SCHEMA, params.queue)
  if (!queue) {
    throw new Response('Queue not found', { status: 404 })
  }

  const [points, history, collection] = await Promise.all([
    getQueueThroughput(DB_URL, SCHEMA, params.queue, { ...span, bucketSeconds }),
    // The gauges at about the throughput panel's resolution, one point per bucket.
    getQueueStatsHistory(DB_URL, SCHEMA, params.queue, {
      ...span,
      aggregate,
      maxDataPoints: Math.round((span.to.getTime() - span.from.getTime()) / 1000 / bucketSeconds),
    }),
    getQueueStatsCollectionStatus(DB_URL, SCHEMA),
  ])

  const filled = fillBuckets(points, span, bucketSeconds)
  const arrived = (p: typeof filled[number]) => p.arrivedPerMin

  return {
    name: queue.name,
    interval,
    statsAvailable: collection.available,
    points: filled,
    range: [span.from.getTime() / 1000, span.to.getTime() / 1000] as [number, number],
    boundary: current.from.getTime() / 1000,
    bucketSeconds,
    history,
    aggregate,
    depthSeries: parseDepthSeries(search.get('series')),
    arrived: { current: windowAverage(filled, current, arrived), previous: windowAverage(filled, previous, arrived) },
    finishing: { current: windowAverage(filled, current, settledPerMin), previous: windowAverage(filled, previous, settledPerMin) },
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

export default function QueueStatsPage ({ loaderData }: Route.ComponentProps) {
  const { name, interval, statsAvailable, points, range, boundary, bucketSeconds, history, aggregate, depthSeries, arrived, finishing } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()
  const { noun } = STATS_INTERVALS[interval]
  const counted = arrived.current != null || arrived.previous != null
  const withKpiSlot = hasProSlot('statsQueueKpi')

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams)
    params.set(key, value)
    setSearchParams(params, { preventScrollReset: true })
  }
  const toggleSeries = (key: DepthSeriesKey) => setParam(
    'series',
    (depthSeries.includes(key) ? depthSeries.filter((s) => s !== key) : [...depthSeries, key]).join(',')
  )
  const changeAggregate = (next: QueueStatsAggregate) => setParam('agg', next)

  return (
    <div className="space-y-4">
      <PageHeader
        title={name}
        subtitle={`Work arriving and finishing, compared with the previous ${noun}`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <StatsIntervalSwitch interval={interval} />
            <Button
              variant="outline"
              size="md"
              render={<DbLink to={`/queues/${encodeURIComponent(name)}`} />}
            >
              <ArrowLeft className="h-4 w-4 mr-1.5" aria-hidden="true" />
              Queue
            </Button>
          </div>
        }
      />

      {!statsAvailable && <StatsDisabledBanner />}

      {statsAvailable && !counted && (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          No throughput counted for this queue in the last {(2 * STATS_INTERVALS[interval].seconds) / 3600} hours. pg-boss
          12.35 and later count it on each monitor pass, with <code className="font-mono text-[0.9em]">persistQueueStats</code> on.
        </p>
      )}

      <section aria-label="Key figures" className={cn('grid gap-4 sm:grid-cols-2', withKpiSlot && 'lg:grid-cols-[1fr_1fr_1.6fr]')}>
        <StatsRateCard
          label="Arrival rate"
          color="var(--stats-arrived)"
          current={arrived.current}
          previous={arrived.previous}
          tone="neutral"
          noun={noun}
          series={points.map((p) => p.arrivedPerMin)}
        />
        <StatsRateCard
          label="Finishing rate"
          color="var(--stats-finishing)"
          current={finishing.current}
          previous={finishing.previous}
          tone="higher-is-better"
          noun={noun}
          series={points.map(settledPerMin)}
        />
        {withKpiSlot && (
          <div className="grid sm:col-span-2 lg:col-span-1">
            <ProSlot name="statsQueueKpi" queue={{ name, interval, bucketSeconds, points }} />
          </div>
        )}
      </section>

      {statsAvailable && (
        <>
          <ThroughputPanel title="Throughput" queue={name} points={points} noun={noun} range={range} bucketSeconds={bucketSeconds} syncKey={`stats:${name}`} />
          <DepthPanel
            queue={name}
            history={history}
            selected={depthSeries}
            onToggle={toggleSeries}
            aggregate={aggregate}
            onAggregate={changeAggregate}
            range={range}
            boundary={boundary}
            bucketSeconds={bucketSeconds}
            noun={noun}
            syncKey={`stats:${name}`}
          />
        </>
      )}
    </div>
  )
}
