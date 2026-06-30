import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import type { AlignedData } from 'uplot'
import type { Route } from './+types/queues.$name.metrics'
import {
  getQueueStatsHistory,
  getQueueStatsCollectionStatus,
  resolveAggregate,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { DbLink } from '~/components/db-link'
import { PageHeader } from '~/components/ui/page-header'
import { Card, CardContent } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { FilterSelect } from '~/components/ui/filter-select'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'
import { UplotChart, type UplotSeries } from '~/components/ui/uplot-chart'
import { cn } from '~/lib/utils'

// Time-range presets. `custom` switches the controls to explicit from/to inputs.
const RANGES = [
  { value: '1h', label: 'Last 1 hour', seconds: 3600 },
  { value: '6h', label: 'Last 6 hours', seconds: 6 * 3600 },
  { value: '24h', label: 'Last 24 hours', seconds: 24 * 3600 },
  { value: '7d', label: 'Last 7 days', seconds: 7 * 86400 },
  { value: '30d', label: 'Last 30 days', seconds: 30 * 86400 },
  { value: 'custom', label: 'Custom range', seconds: 0 },
] as const

type RangeValue = (typeof RANGES)[number]['value']
const DEFAULT_RANGE: RangeValue = '24h'

// Each plottable series: which QueueStatsPoint count it maps to and the CSS variable for its color.
const SERIES_DEFS = [
  { key: 'ready', label: 'Ready', field: 'readyCount', cssVar: '--primary-600' },
  { key: 'failed', label: 'Failed', field: 'failedCount', cssVar: '--error-600' },
  { key: 'active', label: 'Active', field: 'activeCount', cssVar: '--state-active-dot' },
  { key: 'queued', label: 'Queued', field: 'queuedCount', cssVar: '--warning-600' },
  { key: 'deferred', label: 'Deferred', field: 'deferredCount', cssVar: '--text-tertiary' },
  { key: 'total', label: 'Total', field: 'totalCount', cssVar: '--text-secondary' },
] as const

type SeriesKey = (typeof SERIES_DEFS)[number]['key']
const DEFAULT_SERIES: SeriesKey[] = ['ready', 'failed']

const AGG_OPTIONS = [
  { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' },
  { value: 'avg', label: 'Average' },
]

const MIN_DATA_POINTS = 2
const MAX_DATA_POINTS = 4000
const DEFAULT_WIDTH = 800
const CHART_HEIGHT = 320

// null param → defaults; explicit empty string → no series selected (chart shows an empty state).
function parseSeries (raw: string | null): SeriesKey[] {
  if (raw === null) return DEFAULT_SERIES
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SeriesKey => SERIES_DEFS.some((d) => d.key === s))
}

export async function loader ({ params, request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const sp = new URL(request.url).searchParams

  const rangeParam = sp.get('range')
  const range: RangeValue = RANGES.some((r) => r.value === rangeParam)
    ? (rangeParam as RangeValue)
    : DEFAULT_RANGE

  const aggregate = resolveAggregate(sp.get('agg'))

  // Chart pixel width → maxDataPoints, so the server downsamples to ~1 point per pixel.
  const widthParam = Number(sp.get('w'))
  const width = Number.isFinite(widthParam) && widthParam > 0 ? Math.round(widthParam) : DEFAULT_WIDTH
  const maxDataPoints = Math.min(Math.max(width, MIN_DATA_POINTS), MAX_DATA_POINTS)

  // Resolve the time window.
  let from: Date | null = null
  let to: Date | null = null
  if (range === 'custom') {
    const fromMs = Date.parse(sp.get('from') ?? '')
    const toMs = Date.parse(sp.get('to') ?? '')
    from = Number.isFinite(fromMs) ? new Date(fromMs) : null
    to = Number.isFinite(toMs) ? new Date(toMs) : null
  } else {
    const seconds = RANGES.find((r) => r.value === range)!.seconds
    from = new Date(Date.now() - seconds * 1000)
  }

  const [history, collection] = await Promise.all([
    getQueueStatsHistory(DB_URL, SCHEMA, params.name, { from, to, aggregate, maxDataPoints }),
    getQueueStatsCollectionStatus(DB_URL, SCHEMA),
  ])

  return {
    name: params.name,
    history,
    statsAvailable: collection.available,
    range,
    aggregate,
    selectedSeries: parseSeries(sp.get('series')),
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
  }
}

const inputClass = cn(
  'h-[38px] rounded-lg border px-3 py-2 text-sm shadow-sm',
  'bg-[var(--surface-card)] border-[var(--border-strong)] text-[var(--text-primary)]',
  'focus:outline-none focus:border-[var(--border-focus)]'
)

// ISO (UTC) ↔ value for a <input type="datetime-local"> (local wall-clock, minute precision).
function toLocalInput (iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function fromLocalInput (value: string): string | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export default function QueueMetrics ({ loaderData }: Route.ComponentProps) {
  const { name, history, statsAvailable, range, aggregate, selectedSeries, from, to } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()

  const chartWrapRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [chartWidth, setChartWidth] = useState(DEFAULT_WIDTH)
  const [colors, setColors] = useState<{ series: Record<string, string>; grid: string; text: string } | null>(null)

  const setParam = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) params.delete(key)
      else params.set(key, value)
    }
    setSearchParams(params, { preventScrollReset: true })
  }

  const toggleSeries = (key: SeriesKey) => {
    const next = selectedSeries.includes(key)
      ? selectedSeries.filter((s) => s !== key)
      : [...selectedSeries, key]
    setParam({ series: next.join(',') })
  }

  useEffect(() => setMounted(true), [])

  // Resolve CSS-variable colors to concrete values (canvas can't read var()). Re-resolve when the
  // theme class on <html> flips so the chart follows light/dark like the rest of the UI.
  useEffect(() => {
    const resolve = () => {
      const cs = getComputedStyle(document.documentElement)
      const get = (v: string) => cs.getPropertyValue(v).trim() || '#888888'
      const series: Record<string, string> = {}
      for (const d of SERIES_DEFS) series[d.key] = get(d.cssVar)
      setColors({ series, grid: get('--border-default'), text: get('--text-tertiary') })
    }
    resolve()
    const observer = new MutationObserver(resolve)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // Track the chart container width.
  useEffect(() => {
    const node = chartWrapRef.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width)
      if (w > 0) setChartWidth(w)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [mounted])

  // Push the measured width into the `w` param (debounced) so the server downsamples to fit. Only
  // when it has moved enough to matter, to avoid a refetch loop on sub-pixel resizes.
  const currentW = Number(searchParams.get('w')) || DEFAULT_WIDTH
  useEffect(() => {
    if (Math.abs(chartWidth - currentW) <= 8) return
    const timer = setTimeout(() => setParam({ w: String(chartWidth) }), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartWidth, currentW])

  const activeDefs = useMemo(
    () => SERIES_DEFS.filter((d) => selectedSeries.includes(d.key)),
    [selectedSeries]
  )

  const chartData = useMemo<AlignedData>(
    () => [
      history.map((p) => p.capturedOn),
      ...activeDefs.map((d) => history.map((p) => p[d.field] as number)),
    ],
    [history, activeDefs]
  )

  const chartSeries: UplotSeries[] = colors
    ? activeDefs.map((d) => ({ label: d.label, stroke: colors.series[d.key] }))
    : []

  const canRenderChart = mounted && colors && history.length > 0 && selectedSeries.length > 0

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${name} metrics`}
        subtitle="Queue stats history"
        action={
          <DbLink to={`/queues/${encodeURIComponent(name)}`}>
            <Button variant="outline" size="md">
              <ArrowLeft className="h-4 w-4 mr-1.5" aria-hidden="true" />
              Back to queue
            </Button>
          </DbLink>
        }
      />

      {!statsAvailable ? (
        <StatsDisabledBanner />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-end gap-4 py-4">
              <label className="flex flex-col gap-1">
                <span className="pgb-eyebrow">Range</span>
                <FilterSelect<string>
                  value={range}
                  options={RANGES.map((r) => ({ value: r.value as string, label: r.label }))}
                  onChange={(value) => setParam({ range: value })}
                />
              </label>

              {range === 'custom' && mounted && (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="pgb-eyebrow">From</span>
                    <input
                      type="datetime-local"
                      defaultValue={toLocalInput(from)}
                      onChange={(e) => setParam({ from: fromLocalInput(e.target.value) })}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="pgb-eyebrow">To</span>
                    <input
                      type="datetime-local"
                      defaultValue={toLocalInput(to)}
                      onChange={(e) => setParam({ to: fromLocalInput(e.target.value) })}
                      className={inputClass}
                    />
                  </label>
                </>
              )}

              <label className="flex flex-col gap-1">
                <span className="pgb-eyebrow">Aggregate</span>
                <FilterSelect<string>
                  value={aggregate}
                  options={AGG_OPTIONS}
                  onChange={(value) => setParam({ agg: value })}
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className="pgb-eyebrow">Series</span>
                <div className="flex flex-wrap gap-1.5">
                  {SERIES_DEFS.map((d) => {
                    const on = selectedSeries.includes(d.key)
                    return (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() => toggleSeries(d.key)}
                        aria-pressed={on}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs cursor-pointer transition-colors',
                          on
                            ? 'border-[var(--border-strong)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-tertiary)]'
                        )}
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: `var(${d.cssVar})`, opacity: on ? 1 : 0.4 }}
                        />
                        {d.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <div ref={chartWrapRef} className="w-full">
                {canRenderChart ? (
                  <UplotChart
                    data={chartData}
                    series={chartSeries}
                    width={chartWidth}
                    height={CHART_HEIGHT}
                    theme={{ grid: colors!.grid, text: colors!.text }}
                  />
                ) : (
                  <div
                    className="flex items-center justify-center text-sm text-[var(--text-tertiary)]"
                    style={{ height: CHART_HEIGHT }}
                  >
                    {history.length === 0
                      ? 'No data points in this range.'
                      : selectedSeries.length === 0
                        ? 'Select at least one series to plot.'
                        : 'Loading chart…'}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
