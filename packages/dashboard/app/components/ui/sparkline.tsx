import { cn } from '~/lib/utils'

interface SparklineProps {
  /** A null leaves a gap: the line breaks there rather than bridging or dropping to zero. */
  data: Array<number | null>
  width?: number
  height?: number
  /** Stroke color — defaults to a CSS variable so it themes automatically. */
  color?: string
  strokeWidth?: number
  /** Draw a filled dot on the latest value. */
  showDot?: boolean
  /** Scale from zero rather than from the series' own minimum, so a rate's noise is not magnified. */
  zeroBased?: boolean
  /** Shade the left part of the plot, as a fraction of its width (0.5 marks a previous half). */
  shadeTo?: number
  /** Fill the container's width, stretching the plot rather than keeping its aspect ratio. */
  stretch?: boolean
  className?: string
  'aria-label'?: string
}

// Zero-dependency inline-SVG sparkline. Pure and SSR-safe: it self-normalizes the series to its own
// min/max (or 0/max when zeroBased) and renders a <polyline> per run of values between gaps. Nothing
// renders for an empty or all-null series; a lone point shows only the trailing dot; a flat series
// draws a centered horizontal line.
export function Sparkline ({
  data,
  width = 80,
  height = 24,
  color = 'var(--text-tertiary)',
  strokeWidth = 1.5,
  showDot = true,
  zeroBased = false,
  shadeTo,
  stretch = false,
  className,
  'aria-label': ariaLabel,
}: SparklineProps) {
  const values = (data ?? []).filter((v): v is number => v != null)
  if (values.length === 0) return null

  // Inset so the stroke and trailing dot aren't clipped at the edges.
  const pad = strokeWidth + (showDot ? 2 : 0)
  const innerW = Math.max(width - pad * 2, 0)
  const innerH = Math.max(height - pad * 2, 0)

  const min = zeroBased ? Math.min(0, ...values) : Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const n = data.length

  const x = (i: number) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * innerW)
  // Flat series has no span to normalize against — center it instead of pinning it to the baseline.
  const y = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / span) * innerH)

  // Consecutive non-null values, each drawn as its own line.
  const runs: string[] = []
  let run: string[] = []
  data.forEach((v, i) => {
    if (v == null) {
      if (run.length > 1) runs.push(run.join(' '))
      run = []
      return
    }
    run.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`)
  })
  if (run.length > 1) runs.push(run.join(' '))

  const last = data[n - 1]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      // max-w-full keeps the fixed-width SVG from spilling out of a narrower container (e.g. a stat card).
      className={cn('max-w-full overflow-visible', stretch && 'w-full', className)}
      preserveAspectRatio={stretch ? 'none' : undefined}
      role="img"
      aria-label={ariaLabel}
    >
      {shadeTo != null && shadeTo > 0 && (
        <rect x={0} y={0} width={width * Math.min(shadeTo, 1)} height={height} fill="var(--stats-previous-band)" />
      )}
      {runs.map((points, i) => (
        <polyline
          key={i}
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect={stretch ? 'non-scaling-stroke' : undefined}
        />
      ))}
      {showDot && last != null && (
        <circle cx={x(n - 1)} cy={y(last)} r={strokeWidth + 0.5} fill={color} />
      )}
    </svg>
  )
}
