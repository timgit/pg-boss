import { useSearchParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import type { Route } from './+types/stats.$queue'
import {
  getQueue,
  getQueueThroughput,
  getQueueStatsCollectionStatus,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import {
  STATS_INTERVALS,
  fillBuckets,
  parseStatsInterval,
  settledPerMin,
  statsWindows,
  windowAverage,
  type StatsInterval,
} from '~/lib/stats'
import { DbLink } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { PageHeader } from '~/components/ui/page-header'
import { Button } from '~/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'
import { StatsRateCard } from '~/components/stats-rate-card'

export async function loader ({ params, request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const interval = parseStatsInterval(new URL(request.url).searchParams.get('interval'))
  const { bucketSeconds, previous, current } = statsWindows(interval)
  const span = { from: previous.from, to: current.to }

  const queue = await getQueue(DB_URL, SCHEMA, params.queue)
  if (!queue) {
    throw new Response('Queue not found', { status: 404 })
  }

  const [points, collection] = await Promise.all([
    getQueueThroughput(DB_URL, SCHEMA, params.queue, { ...span, bucketSeconds }),
    getQueueStatsCollectionStatus(DB_URL, SCHEMA),
  ])

  const filled = fillBuckets(points, span, bucketSeconds)
  const arrived = (p: typeof filled[number]) => p.arrivedPerMin

  return {
    name: queue.name,
    interval,
    statsAvailable: collection.available,
    points: filled,
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
  const { name, interval, statsAvailable, points, arrived, finishing } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()
  const { noun } = STATS_INTERVALS[interval]
  const counted = arrived.current != null || arrived.previous != null

  const changeInterval = (next: StatsInterval) => {
    const params = new URLSearchParams(searchParams)
    params.set('interval', next)
    setSearchParams(params, { preventScrollReset: true })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={name}
        subtitle={`Work arriving and finishing, compared with the previous ${noun}`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <ToggleGroup
              aria-label="Interval"
              value={[interval]}
              onValueChange={(value) => { if (value[0]) changeInterval(value[0] as StatsInterval) }}
            >
              {Object.keys(STATS_INTERVALS).map((key) => (
                <ToggleGroupItem key={key} value={key}>{key}</ToggleGroupItem>
              ))}
            </ToggleGroup>
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

      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2">
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
      </section>
    </div>
  )
}
