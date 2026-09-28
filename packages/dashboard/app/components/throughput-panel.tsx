import { useEffect, useMemo, useRef, useState } from 'react'
import type uPlot from 'uplot'
import type { AlignedData } from 'uplot'
import type { QueueThroughputPoint } from '~/lib/types'
import { throughputColumns } from '~/lib/stats'
import { formatRate } from '~/components/stats-rate-card'
import { ProSlot, hasProSlot } from '~/components/pro-slot'
import { UplotChart, type PlotBox } from '~/components/ui/uplot-chart'
import { useCssColors, useElementWidth } from '~/components/ui/use-chart-frame'

const HEIGHT = 220

const COLOR_VARS = {
  arrived: '--stats-arrived',
  finishing: '--stats-finishing',
  failed: '--stats-failed',
  ahead: '--stats-gap-ahead',
  behind: '--stats-gap-behind',
  previous: '--stats-previous-band',
  grid: '--border-subtle',
  text: '--text-tertiary',
}

type Colors = Record<keyof typeof COLOR_VARS, string>

// Data columns as uPlot receives them. Failed comes before the lines so its bars draw underneath.
const FAILED = 1
const FINISHING = 2
const ARRIVED = 3

interface Hover {
  idx: number
  left: number
}

// Shades the previous window, and the gap between arrivals and finishing: warning-coloured where
// arrivals lead, faint blue where finishing does. Drawn before the grid and series, so both sit on
// top. The data covers the previous window then the current one, in equal numbers of buckets, so
// the current window starts at the middle bucket.
export function throughputPlugin (colors: Colors, onHover: (hover: Hover | null) => void): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u) => {
        const xs = u.data[0]
        const arrived = u.data[ARRIVED]
        const finishing = u.data[FINISHING]
        const n = xs.length
        if (n < 2) return

        const { ctx } = u
        const { left, top, width, height } = u.bbox
        const x = (i: number) => u.valToPos(xs[i], 'x', true)
        const y = (v: number) => u.valToPos(v, 'y', true)

        ctx.save()
        ctx.beginPath()
        ctx.rect(left, top, width, height)
        ctx.clip()

        ctx.fillStyle = colors.previous
        ctx.fillRect(left, top, x(Math.floor(n / 2)) - left, height)

        for (let i = 0; i < n - 1; i++) {
          const a0 = arrived[i]
          const a1 = arrived[i + 1]
          const f0 = finishing[i]
          const f1 = finishing[i + 1]
          if (a0 == null || a1 == null || f0 == null || f1 == null) continue
          ctx.fillStyle = a0 + a1 > f0 + f1 ? colors.ahead : colors.behind
          ctx.beginPath()
          ctx.moveTo(x(i), y(a0))
          ctx.lineTo(x(i + 1), y(a1))
          ctx.lineTo(x(i + 1), y(f1))
          ctx.lineTo(x(i), y(f0))
          ctx.closePath()
          ctx.fill()
        }

        ctx.restore()
      },
      setCursor: (u) => {
        const { idx, left } = u.cursor
        onHover(idx == null || left == null || left < 0 ? null : { idx, left: left + u.over.offsetLeft })
      },
    },
  }
}

function formatTime (seconds: number, withDay: boolean): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    ...(withDay ? { weekday: 'short' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Axis ticks are round numbers, so no decimals unless the scale is below one.
const formatTick = (v: number) => (Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : formatRate(v))

const rate = (v: number | null | undefined) => (v == null ? '—' : `${formatRate(v)}/min`)

function LegendKey ({ color, shape, children }: { color: string, shape: 'line' | 'bar' | 'band', children: string }) {
  const size = shape === 'line' ? 'h-0.5 w-3' : shape === 'bar' ? 'h-2.5 w-1.5' : 'h-2.5 w-3'
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block rounded-[1px] ${size}`} style={{ background: color }} />
      {children}
    </span>
  )
}

interface ThroughputPanelProps {
  title: string
  /** The queue charted, or null for all queues together. */
  queue: string | null
  /** Every bucket across the previous and current windows, in order, gaps as empty points. */
  points: QueueThroughputPoint[]
  /** "hour", "6 hours", "24 hours": what the shaded half stands for. */
  noun: string
  /** The x extent in unix seconds: the previous window's start to the current window's end. */
  range: [number, number]
  /** Bucket width in seconds: a line bridges one missing bucket rather than breaking. */
  bucketSeconds?: number
  /** Charts sharing a key move one cursor together. */
  syncKey?: string
}

// Arrivals against jobs finishing (completed + failed), per minute, over the previous and current
// windows: the gap between the lines shaded, failures as bars along the bottom, and a tooltip.
// Fixed series, no toggles.
export function ThroughputPanel ({ title, queue, points, noun, range, bucketSeconds, syncKey }: ThroughputPanelProps) {
  const [mounted, setMounted] = useState(false)
  const [frameRef, width] = useElementWidth<HTMLDivElement>(800)
  const colors = useCssColors(COLOR_VARS)
  const [hover, setHover] = useState<Hover | null>(null)
  const [plotBox, setPlotBox] = useState<PlotBox | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  useEffect(() => setMounted(true), [])

  const [xs, arrived, finishing, failed] = useMemo(() => throughputColumns(points), [points])
  const data = useMemo<AlignedData>(() => [xs, failed, finishing, arrived], [xs, failed, finishing, arrived])
  const counted = arrived.some((v) => v != null) || finishing.some((v) => v != null)

  const plugins = useMemo(() => (colors ? [throughputPlugin(colors, setHover)] : []), [colors])
  const series = useMemo(() => colors
    ? [
        { label: 'Failed', stroke: colors.failed, bars: true },
        { label: 'Finishing', stroke: colors.finishing },
        { label: 'Arrived', stroke: colors.arrived },
      ]
    : [], [colors])

  const withDay = xs.length > 1 && xs[xs.length - 1] - xs[0] > 12 * 3600
  // Flip the tooltip to the left of the cursor past the middle, so it never runs off the panel.
  const tipLeft = hover && (hover.left > width * 0.6 ? hover.left - (tipRef.current?.offsetWidth ?? 160) - 12 : hover.left + 12)

  return (
    <section
      aria-label={title}
      className="rounded-[10px] border border-[var(--border-default)] px-4 pb-2 pt-3.5 shadow-sm"
      style={{ background: 'var(--surface-card-grad)' }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="pgb-eyebrow">{title}</h2>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-[var(--text-secondary)]">
          <LegendKey color="var(--stats-arrived)" shape="line">Arrived /min</LegendKey>
          <LegendKey color="var(--stats-finishing)" shape="line">Finishing /min</LegendKey>
          <LegendKey color="var(--stats-failed)" shape="bar">Failed /min</LegendKey>
          <LegendKey color="var(--stats-gap-ahead)" shape="band">Arrivals ahead</LegendKey>
          <LegendKey color="var(--stats-previous-band)" shape="band">{`Previous ${noun}`}</LegendKey>
        </div>
      </div>

      <div ref={frameRef} className="relative w-full" role="img" aria-label={`${title}: jobs arriving and finishing per minute over the previous and current ${noun}`}>
        {mounted && colors && counted ? (
          <>
            <UplotChart
              data={data}
              series={series}
              width={width}
              height={HEIGHT}
              theme={{ grid: colors.grid, text: colors.text }}
              plugins={plugins}
              zeroBased
              yValue={formatTick}
              xRange={range}
              bridgeSeconds={bucketSeconds && 2 * bucketSeconds}
              syncKey={syncKey}
              legend={false}
              onPlotBox={setPlotBox}
            />
            {hover && (
              <div
                ref={tipRef}
                className="pointer-events-none absolute top-2.5 z-10 whitespace-nowrap rounded-[7px] border border-[var(--border-strong)] bg-[var(--surface-card)] px-2.5 py-2 text-xs shadow-md"
                style={{ left: tipLeft ?? 0 }}
              >
                <div className="pgb-num mb-1 text-[11px] text-[var(--text-tertiary)]">{formatTime(xs[hover.idx], withDay)}</div>
                <TipRow color="var(--stats-arrived)" label="Arrived" value={rate(arrived[hover.idx])} />
                <TipRow color="var(--stats-finishing)" label="Finishing" value={rate(finishing[hover.idx])} />
                <TipRow color="var(--stats-failed)" label="Failed" value={rate(failed[hover.idx])} />
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center text-sm text-[var(--text-tertiary)]" style={{ height: HEIGHT }}>
            {mounted && !counted ? 'No throughput counted in this range.' : 'Loading chart…'}
          </div>
        )}
      </div>
      {plotBox && hasProSlot('statsChartMarkers') && (
        <ProSlot name="statsChartMarkers" queue={queue} chart="throughput" from={range[0]} to={range[1]} plot={plotBox} />
      )}
    </section>
  )
}

function TipRow ({ color, label, value }: { color: string, label: string, value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[var(--text-secondary)]">
      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-[2px]" style={{ background: color }} />
      {label} <b className="pgb-num ml-auto pl-3 font-semibold text-[var(--text-primary)]">{value}</b>
    </div>
  )
}
