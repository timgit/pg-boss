import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import type { AlignedData, Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { niceMax } from '~/lib/stats'

export interface UplotSeries {
  label: string
  /** Concrete CSS color (resolve CSS variables before passing — canvas can't read var()). */
  stroke: string
  /** Draw as bars from zero instead of a line, filled with the stroke color. */
  bars?: boolean
  /** Line width in pixels, 2 by default. */
  width?: number
  /** Dash pattern, as canvas setLineDash takes it. */
  dash?: number[]
}

export interface PlotBox {
  left: number
  width: number
}

interface UplotChartProps {
  /** uPlot aligned data: [xValues, ...ySeries]. x is unix seconds. */
  data: AlignedData
  series: UplotSeries[]
  width: number
  height: number
  /** Resolved theme colors for axes/grid/text. */
  theme: { grid: string; text: string }
  /** Extra drawing and cursor hooks. Pass a memoized array: a new one rebuilds the plot. */
  plugins?: uPlot.Plugin[]
  /** Scale y from zero to a round maximum rather than fitting the data's own range. */
  zeroBased?: boolean
  /** A log scale for y, for durations that span orders of magnitude. Values must be above zero. */
  yLog?: boolean
  /** Formats a y-axis tick. Pass a stable function: a new one rebuilds the plot. */
  yValue?: (value: number) => string
  /** The x extent in unix seconds, so charts over the same window line up whatever their data covers. */
  xRange?: [number, number]
  /**
   * Lines bridge a gap up to this many seconds wide instead of breaking, so one bucket that a
   * sampler happened to miss does not cut the line. Longer gaps still break it.
   */
  bridgeSeconds?: number
  /** Charts sharing a key move one cursor together. */
  syncKey?: string
  /** Told where the plot area sits across the chart, in CSS pixels, whenever that changes. */
  onPlotBox?: (box: PlotBox) => void
  /** uPlot's live legend under the plot. Off when the caller draws its own legend or tooltip. */
  legend?: boolean
}

// Thin React wrapper around uPlot. The instance is created in an effect (uPlot touches the DOM, so
// this component must only render on the client — callers gate it behind a mounted flag).
// The plot is rebuilt only when its structure (series/theme/plugins) changes; data and size updates
// are applied in place via setData/setSize so panning the range or resizing stays cheap.
export function UplotChart ({
  data,
  series,
  width,
  height,
  theme,
  plugins,
  zeroBased = false,
  yLog = false,
  yValue,
  xRange,
  bridgeSeconds,
  syncKey,
  onPlotBox,
  legend = true,
}: UplotChartProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Read by the x scale on every redraw, so a new window applies with the data, without a rebuild.
  const xRangeRef = useRef(xRange)
  xRangeRef.current = xRange
  const fixedX = xRange != null
  const onPlotBoxRef = useRef(onPlotBox)
  onPlotBoxRef.current = onPlotBox

  // Rebuild key — only the structure, not the data/size, forces a fresh uPlot instance.
  const seriesKey = series.map((s) => `${s.label}:${s.stroke}:${s.bars ? 'bars' : 'line'}:${s.width ?? 2}:${s.dash?.join(',') ?? ''}`).join('|')

  useEffect(() => {
    if (!elRef.current) return

    const axis = {
      stroke: theme.text,
      grid: { stroke: theme.grid, width: 1 },
      ticks: { stroke: theme.grid, width: 1 },
    }
    const yAxis = yValue
      ? { ...axis, values: (_u: uPlot, splits: number[]) => splits.map(yValue) }
      : axis

    // Gaps arrive in canvas pixels; convert their width to seconds on the x scale.
    const gaps: uPlot.Series.GapsRefiner | undefined = bridgeSeconds
      ? (u, _series, _idx0, _idx1, nullGaps) => {
          const { min, max } = u.scales.x
          if (min == null || max == null) return nullGaps
          const secondsPerPx = (max - min) / u.bbox.width
          return nullGaps.filter(([from, to]) => (to - from) * secondsPerPx > bridgeSeconds)
        }
      : undefined

    const reportBox = (u: uPlot) => onPlotBoxRef.current?.({ left: u.bbox.left / uPlot.pxRatio, width: u.bbox.width / uPlot.pxRatio })

    const opts: Options = {
      width,
      height,
      cursor: { y: false, ...(syncKey ? { sync: { key: syncKey } } : {}) },
      legend: { show: legend, live: true },
      scales: {
        x: fixedX
          ? { time: true, range: (_u: uPlot, min: number | null, max: number | null): uPlot.Range.MinMax => xRangeRef.current ?? [min, max] }
          : { time: true },
        ...(yLog
          ? { y: { distr: 3, log: 10 } }
          : zeroBased
            ? { y: { range: (_u: uPlot, _min: number | null, max: number | null): uPlot.Range.MinMax => [0, niceMax(max)] } }
            : {}),
      },
      axes: [axis, yAxis],
      plugins,
      hooks: {
        // bbox is in canvas pixels; the page lays out in CSS pixels.
        ready: [reportBox],
        setSize: [reportBox],
      },
      series: [
        {},
        ...series.map((s) => s.bars
          ? {
              label: s.label,
              stroke: s.stroke,
              fill: s.stroke,
              width: 0,
              paths: uPlot.paths.bars!({ size: [0.6, 12] }),
              points: { show: false },
            }
          : {
              label: s.label,
              stroke: s.stroke,
              width: s.width ?? 2,
              ...(s.dash ? { dash: s.dash } : {}),
              points: { show: false },
              // Only when set: an explicit undefined replaces uPlot's default and breaks drawing.
              ...(gaps ? { gaps } : {}),
            }),
      ],
    }

    const plot = new uPlot(opts, data, elRef.current)
    plotRef.current = plot
    return () => {
      plot.destroy()
      plotRef.current = null
    }
    // Rebuild on structure/theme change only; data & size are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, theme.grid, theme.text, plugins, zeroBased, yLog, yValue, fixedX, bridgeSeconds, syncKey, legend])

  // Update data in place (range/aggregate changes) without rebuilding.
  useEffect(() => {
    plotRef.current?.setData(data)
  }, [data])

  // Update size in place (container resize) without rebuilding.
  useEffect(() => {
    plotRef.current?.setSize({ width, height })
  }, [width, height])

  return <div ref={elRef} />
}
