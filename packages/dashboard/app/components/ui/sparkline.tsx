import { cn } from '~/lib/utils'

interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  /** Stroke color — defaults to a CSS variable so it themes automatically. */
  color?: string
  strokeWidth?: number
  /** Draw a filled dot on the latest value. */
  showDot?: boolean
  className?: string
  'aria-label'?: string
}

// Zero-dependency inline-SVG sparkline. Pure and SSR-safe: it self-normalizes the series to its own
// min/max and renders a single <polyline>. Nothing renders for an empty series; a single point shows
// just the trailing dot; a flat series draws a centered horizontal line.
export function Sparkline ({
  data,
  width = 80,
  height = 24,
  color = 'var(--text-tertiary)',
  strokeWidth = 1.5,
  showDot = true,
  className,
  'aria-label': ariaLabel,
}: SparklineProps) {
  if (!data || data.length === 0) return null

  // Inset so the stroke and trailing dot aren't clipped at the edges.
  const pad = strokeWidth + (showDot ? 2 : 0)
  const innerW = Math.max(width - pad * 2, 0)
  const innerH = Math.max(height - pad * 2, 0)

  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const n = data.length

  const x = (i: number) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * innerW)
  const y = (v: number) => pad + (1 - (v - min) / span) * innerH

  const points = data.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label={ariaLabel}
    >
      {n > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {showDot && (
        <circle cx={x(n - 1)} cy={y(data[n - 1])} r={strokeWidth + 0.5} fill={color} />
      )}
    </svg>
  )
}
