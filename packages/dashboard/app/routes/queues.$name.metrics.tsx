import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import type { AlignedData } from 'uplot'
import type { RouterContextProvider } from 'react-router'
import {
  getQueueStatsHistory,
  getQueueStatsCollectionStatus,
  resolveAggregate,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { waitingBreakdown } from '~/lib/queue-metrics'
import { PageHeader } from '~/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Checkbox } from '~/components/ui/checkbox'
import { Count } from '~/components/ui/count'
import { FilterSelect } from '~/components/ui/filter-select'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'
import { UplotChart, type UplotSeries } from '~/components/ui/uplot-chart'
import { useCssColors, useElementWidth, withAlpha } from '~/components/ui/use-chart-frame'
import { cn } from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => (params.name ? `${params.name} counts over time` : null) }

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

const AGG_OPTIONS = [
  { value: 'max', label: 'Highest in its bucket' },
  { value: 'min', label: 'Lowest in its bucket' },
  { value: 'avg', label: 'Average of its bucket' },
]

// The CSS variable behind each series' color, and the axes'. Resolved to concrete colors for the canvas.
const COLOR_VARS = {
  ready: '--stats-ready',
  blocked: '--stats-blocked',
  deferred: '--neutral-400',
  active: '--state-active-dot',
  failed: '--error-600',
  total: '--text-secondary',
  grid: '--border-default',
  text: '--text-tertiary',
}

const BLOCKED_LABEL = 'Blocked by a flow parent'
// Opacity of the stacked areas, so the grid still shows through.
const FILL_ALPHA = 0.4
// The charts on this page move one cursor together.
const SYNC_KEY = 'queue-metrics'

const MIN_DATA_POINTS = 2
const MAX_DATA_POINTS = 4000
const DEFAULT_WIDTH = 800
const CHART_HEIGHT = 280

// Typed by hand rather than from `./+types/queues.$name.metrics`: a Pro build replaces this route
// with a redirect to the queue page's Backlog chart, React Router then generates no types for it,
// and the build still typechecks this file.
export async function loader ({ params, request, context }: { params: { name?: string }, request: Request, context: Readonly<RouterContextProvider> }) {
  const name = params.name ?? ''
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
    getQueueStatsHistory(DB_URL, SCHEMA, name, { from, to, aggregate, maxDataPoints }),
    getQueueStatsCollectionStatus(DB_URL, SCHEMA),
  ])

  return {
    name,
    history,
    statsAvailable: collection.available,
    range,
    aggregate,
    showTotal: sp.get('total') === '1',
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

interface LegendEntry {
  label: string
  /** CSS variable for the swatch; none for a figure the chart does not draw. */
  cssVar?: string
  value: number | null
}

// A chart's series beside its title, each with its latest value, then any figure set off after a rule.
function ChartLegend ({ entries, after }: { entries: LegendEntry[], after?: LegendEntry }) {
  const item = (e: LegendEntry) => (
    <span key={e.label} className="inline-flex items-center gap-1.5">
      {e.cssVar && <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `var(${e.cssVar})` }} />}
      <span className="text-[var(--text-secondary)]">{e.label}</span>
      <span className="pgb-num text-[var(--text-primary)]">{e.value == null ? '—' : <Count value={e.value} />}</span>
    </span>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {entries.map(item)}
      {after && (
        <>
          <span className="h-3.5 w-px bg-[var(--border-strong)]" aria-hidden />
          {item(after)}
        </>
      )}
    </div>
  )
}

function ChartCard ({ id, title, description, legend, children }: {
  id: string
  title: string
  description: string
  legend: ReactNode
  children: ReactNode
}) {
  return (
    <Card id={id} className="scroll-mt-4">
      <CardHeader className="flex-wrap items-start">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {legend}
      </CardHeader>
      <CardContent className="py-4">{children}</CardContent>
    </Card>
  )
}

function ChartPlaceholder ({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-center text-sm text-[var(--text-tertiary)]"
      style={{ height: CHART_HEIGHT }}
    >
      {children}
    </div>
  )
}

export default function QueueMetrics ({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { name, history, statsAvailable, range, aggregate, showTotal, from, to } = loaderData
  const [searchParams, setSearchParams] = useSearchParams()

  const [mounted, setMounted] = useState(false)
  // Both charts span the same width, so one measurement sizes both and sets the `w` param.
  const [chartWrapRef, chartWidth] = useElementWidth<HTMLDivElement>(DEFAULT_WIDTH)
  const colors = useCssColors(COLOR_VARS)

  const setParam = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams)
    // Left in old links by the series chips this page used to have.
    params.delete('series')
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) params.delete(key)
      else params.set(key, value)
    }
    setSearchParams(params, { preventScrollReset: true })
  }

  useEffect(() => setMounted(true), [])

  // Push the measured width into the `w` param (debounced) so the server downsamples to fit. Only
  // when it has moved enough to matter, to avoid a refetch loop on sub-pixel resizes.
  const currentW = Number(searchParams.get('w')) || DEFAULT_WIDTH
  useEffect(() => {
    if (Math.abs(chartWidth - currentW) <= 8) return
    const timer = setTimeout(() => setParam({ w: String(chartWidth) }), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartWidth, currentW])

  const waiting = useMemo(() => waitingBreakdown(history), [history])
  const x = useMemo(() => history.map((p) => p.capturedOn), [history])

  // Bottom to top: Ready, Blocked, Deferred. Each series' own counts; the chart does the stacking.
  const waitingData = useMemo<AlignedData>(
    () => [x, waiting.ready, waiting.blocked, waiting.deferred],
    [x, waiting]
  )
  const waitingSeries = useMemo<UplotSeries[]>(
    () => colors
      ? [
          { label: 'Ready', stroke: colors.ready, fill: withAlpha(colors.ready, FILL_ALPHA), width: 1.5 },
          { label: BLOCKED_LABEL, stroke: colors.blocked, fill: withAlpha(colors.blocked, FILL_ALPHA), width: 1.5 },
          { label: 'Deferred', stroke: colors.deferred, fill: withAlpha(colors.deferred, FILL_ALPHA), width: 1.5 },
        ]
      : [],
    [colors]
  )

  const workData = useMemo<AlignedData>(
    () => [
      x,
      history.map((p) => p.activeCount),
      history.map((p) => p.failedCount),
      ...(showTotal ? [history.map((p) => p.totalCount)] : []),
    ],
    [x, history, showTotal]
  )
  const workSeries = useMemo<UplotSeries[]>(
    () => colors
      ? [
          { label: 'Active', stroke: colors.active },
          { label: 'Failed', stroke: colors.failed },
          ...(showTotal ? [{ label: 'Total stored', stroke: colors.total, width: 1.5, dash: [4, 4] }] : []),
        ]
      : [],
    [colors, showTotal]
  )

  const latest = history.length > 0 ? history[history.length - 1] : null
  const latestBlocked = waiting.blocked.length > 0 ? waiting.blocked[waiting.blocked.length - 1] : null

  const theme = colors ? { grid: colors.grid, text: colors.text } : null
  const canRenderChart = mounted && theme != null && history.length > 0
  const placeholder = history.length === 0 ? 'No data points in this range.' : 'Loading chart…'

  return (
    <div className="space-y-4">
      <PageHeader
        parent={{ to: `/queues/${encodeURIComponent(name)}`, label: name }}
        title={`${name}: counts over time`}
        subtitle="From the counts pg-boss records each monitor pass."
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
                <span className="pgb-eyebrow">Each point is the</span>
                <FilterSelect<string>
                  value={aggregate}
                  options={AGG_OPTIONS}
                  onChange={(value) => setParam({ agg: value })}
                />
              </label>

              <div className="flex h-[38px] items-center">
                <Checkbox
                  id="metrics-show-total"
                  label="Show total stored"
                  checked={showTotal}
                  onChange={(e) => setParam({ total: e.target.checked ? '1' : null })}
                />
              </div>
            </CardContent>
          </Card>

          <ChartCard
            id="waiting"
            title="Waiting"
            description="Every job not started yet, by why it is waiting. Together they are Queued."
            legend={
              <ChartLegend
                entries={[
                  { label: 'Ready', cssVar: COLOR_VARS.ready, value: latest?.readyCount ?? null },
                  { label: BLOCKED_LABEL, cssVar: COLOR_VARS.blocked, value: latestBlocked },
                  { label: 'Deferred', cssVar: COLOR_VARS.deferred, value: latest?.deferredCount ?? null },
                ]}
                after={{ label: 'Queued', value: latest?.queuedCount ?? null }}
              />
            }
          >
            <div ref={chartWrapRef} className="w-full">
              {canRenderChart ? (
                <UplotChart
                  data={waitingData}
                  series={waitingSeries}
                  width={chartWidth}
                  height={CHART_HEIGHT}
                  theme={theme}
                  zeroBased
                  stacked
                  syncKey={SYNC_KEY}
                />
              ) : (
                <ChartPlaceholder>{placeholder}</ChartPlaceholder>
              )}
            </div>
          </ChartCard>

          <ChartCard
            id="active"
            title="Active and failed"
            description="Jobs being worked, and failures still stored."
            legend={
              <ChartLegend
                entries={[
                  { label: 'Active', cssVar: COLOR_VARS.active, value: latest?.activeCount ?? null },
                  { label: 'Failed', cssVar: COLOR_VARS.failed, value: latest?.failedCount ?? null },
                  ...(showTotal ? [{ label: 'Total stored', cssVar: COLOR_VARS.total, value: latest?.totalCount ?? null }] : []),
                ]}
              />
            }
          >
            {canRenderChart ? (
              <UplotChart
                data={workData}
                series={workSeries}
                width={chartWidth}
                height={CHART_HEIGHT}
                theme={theme}
                zeroBased
                syncKey={SYNC_KEY}
              />
            ) : (
              <ChartPlaceholder>{placeholder}</ChartPlaceholder>
            )}
          </ChartCard>

          <p className="text-xs text-[var(--text-tertiary)]">Blocked is Queued less Ready and Deferred.</p>
        </>
      )}
    </div>
  )
}
