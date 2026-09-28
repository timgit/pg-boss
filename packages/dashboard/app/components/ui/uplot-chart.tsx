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
  /** Formats a y-axis tick. Pass a stable function: a new one rebuilds the plot. */
  yValue?: (value: number) => string
  /** Charts sharing a key move one cursor together. */
  syncKey?: string
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
  yValue,
  syncKey,
  legend = true,
}: UplotChartProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  // Rebuild key — only the structure, not the data/size, forces a fresh uPlot instance.
  const seriesKey = series.map((s) => `${s.label}:${s.stroke}:${s.bars ? 'bars' : 'line'}`).join('|')

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

    const opts: Options = {
      width,
      height,
      cursor: { y: false, ...(syncKey ? { sync: { key: syncKey } } : {}) },
      legend: { show: legend, live: true },
      scales: {
        x: { time: true },
        ...(zeroBased
          ? { y: { range: (_u: uPlot, _min: number | null, max: number | null): uPlot.Range.MinMax => [0, niceMax(max)] } }
          : {}),
      },
      axes: [axis, yAxis],
      plugins,
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
              width: 2,
              points: { show: false },
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
  }, [seriesKey, theme.grid, theme.text, plugins, zeroBased, yValue, syncKey, legend])

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
