import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import type { AlignedData, Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'

export interface UplotSeries {
  label: string
  /** Concrete CSS color (resolve CSS variables before passing — canvas can't read var()). */
  stroke: string
}

interface UplotChartProps {
  /** uPlot aligned data: [xValues, ...ySeries]. x is unix seconds. */
  data: AlignedData
  series: UplotSeries[]
  width: number
  height: number
  /** Resolved theme colors for axes/grid/text. */
  theme: { grid: string; text: string }
}

// Thin React wrapper around uPlot. The instance is created in an effect (uPlot touches the DOM, so
// this component must only render on the client — the metrics page gates it behind a mounted flag).
// The plot is rebuilt only when its structure (series/theme) changes; data and size updates are
// applied in place via setData/setSize so panning the range or resizing stays cheap.
export function UplotChart ({ data, series, width, height, theme }: UplotChartProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  // Rebuild key — only the structure, not the data/size, forces a fresh uPlot instance.
  const seriesKey = series.map((s) => `${s.label}:${s.stroke}`).join('|')

  useEffect(() => {
    if (!elRef.current) return

    const axis = {
      stroke: theme.text,
      grid: { stroke: theme.grid, width: 1 },
      ticks: { stroke: theme.grid, width: 1 },
    }

    const opts: Options = {
      width,
      height,
      cursor: { y: false },
      legend: { live: true },
      scales: { x: { time: true } },
      axes: [axis, axis],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.stroke,
          width: 2,
          points: { show: false },
        })),
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
  }, [seriesKey, theme.grid, theme.text])

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
