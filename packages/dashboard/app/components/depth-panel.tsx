import { useEffect, useMemo, useRef, useState } from 'react'
import type uPlot from 'uplot'
import type { AlignedData } from 'uplot'
import type { QueueStatsAggregate, QueueStatsPoint } from '~/lib/types'
import { DEPTH_SERIES, type DepthSeriesKey } from '~/lib/stats'
import { FilterSelect } from '~/components/ui/filter-select'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import { UplotChart, type PlotBox, type UplotSeries } from '~/components/ui/uplot-chart'
import { useCssColors, useElementWidth } from '~/components/ui/use-chart-frame'
import { cn } from '~/lib/utils'

const HEIGHT = 180

const COLOR_VARS = {
  ...Object.fromEntries(DEPTH_SERIES.map((d) => [d.key, d.cssVar])) as Record<DepthSeriesKey, string>,
  previous: '--stats-previous-band',
  grid: '--border-subtle',
  text: '--text-tertiary',
}

const AGG_OPTIONS: Array<{ value: QueueStatsAggregate, label: string }> = [
  { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' },
  { value: 'avg', label: 'Average' },
]

const formatCount = (v: number) => Math.round(v).toLocaleString('en-US')

// Shades the previous window, up to `boundary` (unix seconds), read from a ref so a new interval
// applies without rebuilding the plot.
function previousBandPlugin (color: string, boundary: { current: number }): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u) => {
        const { left, top, width, height } = u.bbox
        const x = Math.min(Math.max(u.valToPos(boundary.current, 'x', true), left), left + width)
        u.ctx.save()
        u.ctx.fillStyle = color
        u.ctx.fillRect(left, top, x - left, height)
        u.ctx.restore()
      },
    },
  }
}

interface DepthPanelProps {
  queue: string
  history: QueueStatsPoint[]
  selected: DepthSeriesKey[]
  onToggle: (key: DepthSeriesKey) => void
  aggregate: QueueStatsAggregate
  onAggregate: (aggregate: QueueStatsAggregate) => void
  /** The x extent in unix seconds: the previous window's start to the current window's end. */
  range: [number, number]
  /** Where the current window starts, in unix seconds. */
  boundary: number
  noun: string
  syncKey?: string
}

// The queue's gauges over the previous and current windows, ready only by default, the rest behind
// the series picker. Shares the throughput panel's time axis and cursor.
export function DepthPanel ({ queue, history, selected, onToggle, aggregate, onAggregate, range, boundary, noun, syncKey }: DepthPanelProps) {
  const [mounted, setMounted] = useState(false)
  const [frameRef, width] = useElementWidth<HTMLDivElement>(800)
  const colors = useCssColors(COLOR_VARS)
  const boundaryRef = useRef(boundary)
  const [plotBox, setPlotBox] = useState<PlotBox | null>(null)
  boundaryRef.current = boundary

  useEffect(() => setMounted(true), [])

  const active = useMemo(() => DEPTH_SERIES.filter((d) => selected.includes(d.key)), [selected])
  const data = useMemo<AlignedData>(
    () => [history.map((p) => p.capturedOn), ...active.map((d) => history.map((p) => p[d.field]))],
    [history, active]
  )
  const series: UplotSeries[] = useMemo(
    () => (colors ? active.map((d) => ({ label: d.label, stroke: colors[d.key] })) : []),
    [colors, active]
  )
  const plugins = useMemo(() => (colors ? [previousBandPlugin(colors.previous, boundaryRef)] : []), [colors, boundaryRef])

  const empty = history.length === 0 ? 'No depth recorded in this range.' : selected.length === 0 ? 'Select at least one series to plot.' : null

  return (
    <section
      aria-label="Depth"
      className="rounded-[10px] border border-[var(--border-default)] px-4 pb-2 pt-3.5 shadow-sm"
      style={{ background: 'var(--surface-card-grad)' }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="pgb-eyebrow">Depth</h2>
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Series" className="flex flex-wrap gap-1.5">
            {DEPTH_SERIES.map((d) => {
              const on = selected.includes(d.key)
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => onToggle(d.key)}
                  aria-pressed={on}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    on
                      ? 'border-[var(--border-strong)] bg-[var(--surface-hover)] text-[var(--text-primary)]'
                      : 'border-[var(--border-subtle)] text-[var(--text-tertiary)]'
                  )}
                >
                  <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: `var(${d.cssVar})`, opacity: on ? 1 : 0.4 }} />
                  {d.label}
                </button>
              )
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
            Per bucket
            <FilterSelect<QueueStatsAggregate>
              value={aggregate}
              options={AGG_OPTIONS}
              onChange={onAggregate}
              className="py-1 text-xs"
            />
          </label>
        </div>
      </div>

      <div ref={frameRef} className="w-full" role="img" aria-label={`Queue depth over the previous and current ${noun}`}>
        {mounted && colors && !empty ? (
          <UplotChart
            data={data}
            series={series}
            width={width}
            height={HEIGHT}
            theme={{ grid: colors.grid, text: colors.text }}
            plugins={plugins}
            zeroBased
            yValue={formatCount}
            xRange={range}
            syncKey={syncKey}
            onPlotBox={setPlotBox}
          />
        ) : (
          <div className="flex items-center justify-center text-sm text-[var(--text-tertiary)]" style={{ height: HEIGHT }}>
            {mounted ? (empty ?? 'Loading chart…') : 'Loading chart…'}
          </div>
        )}
      </div>
      {plotBox && hasProSlot('statsChartMarkers') && (
        <ProSlot name="statsChartMarkers" queue={queue} chart="depth" from={range[0]} to={range[1]} plot={plotBox} />
      )}
    </section>
  )
}
