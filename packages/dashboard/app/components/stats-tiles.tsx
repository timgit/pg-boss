import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import overlay from '~pro'
import type { StatsTileAssessment } from '~/lib/pro-contract'
import type { QueueThroughputPoint } from '~/lib/types'
import { byBusiest, niceMax, throughputColumns, type StatsInterval, type StatsQueueSummary } from '~/lib/stats'
import { formatRate } from '~/components/stats-rate-card'
import { DbLink } from '~/components/db-link'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { cn } from '~/lib/utils'

export const TILE_LIMIT = 8

const W = 240
const H = 52

// Arrivals against jobs finishing over both windows, on the tile's own scale: the previous window
// shaded, the gap between the lines shaded by which side leads. Plain SVG, so it renders on the
// server with the rest of the tile.
export function TileChart ({ points }: { points: QueueThroughputPoint[] }) {
  const [, arrived, finishing] = throughputColumns(points)
  const n = points.length
  const top = niceMax(Math.max(0, ...arrived.map((v) => v ?? 0), ...finishing.map((v) => v ?? 0)))
  const x = (i: number) => (n < 2 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => H - 1 - (v / top) * (H - 8)

  const line = (values: Array<number | null>) => {
    const runs: string[] = []
    let run: string[] = []
    values.forEach((v, i) => {
      if (v == null) {
        if (run.length > 1) runs.push(run.join(' '))
        run = []
      } else {
        run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      }
    })
    if (run.length > 1) runs.push(run.join(' '))
    return runs
  }

  const gaps: Array<{ points: string, ahead: boolean }> = []
  for (let i = 0; i < n - 1; i++) {
    const a0 = arrived[i]
    const a1 = arrived[i + 1]
    const f0 = finishing[i]
    const f1 = finishing[i + 1]
    if (a0 == null || a1 == null || f0 == null || f1 == null) continue
    gaps.push({
      points: `${x(i)},${y(a0)} ${x(i + 1)},${y(a1)} ${x(i + 1)},${y(f1)} ${x(i)},${y(f0)}`,
      ahead: a0 + a1 > f0 + f1,
    })
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[52px] w-full" aria-hidden="true">
        <rect x={0} y={0} width={W / 2} height={H} fill="var(--stats-previous-band)" />
        <line x1={0} x2={W} y1={y(top)} y2={y(top)} stroke="var(--border-subtle)" vectorEffect="non-scaling-stroke" />
        {gaps.map((g, i) => (
          <polygon key={i} points={g.points} fill={g.ahead ? 'var(--stats-gap-ahead)' : 'var(--stats-gap-behind)'} />
        ))}
        {line(finishing).map((p, i) => (
          <polyline key={`f${i}`} points={p} fill="none" stroke="var(--stats-finishing)" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
        {line(arrived).map((p, i) => (
          <polyline key={`a${i}`} points={p} fill="none" stroke="var(--stats-arrived)" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--border-default)" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="pgb-num absolute -top-0.5 right-0 bg-[var(--surface-card)] pl-1 text-[10px] text-[var(--text-tertiary)] group-hover:bg-[var(--surface-hover)]">
        {formatRate(top)}/min
      </span>
    </div>
  )
}

function Rate ({ value, color, label }: { value: number | null, color: string, label: string }) {
  return (
    <div>
      <b className="pgb-num block text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
        {value == null ? '—' : `${formatRate(value)}/min`}
      </b>
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
        <span aria-hidden="true" className="inline-block h-0.5 w-2 rounded-full" style={{ background: color }} />
        {label}
      </span>
    </div>
  )
}

function formatShare (share: number | null): string | null {
  if (share == null) return null
  if (share > 0 && share < 0.01) return '<1% of arrivals'
  return `${Math.round(share * 100)}% of arrivals`
}

const SEVERITY_BORDER = {
  critical: 'border-[var(--error-500)]',
  watch: 'border-[var(--warning-500)]',
}

interface StatsTileProps {
  tile: StatsQueueSummary
  interval: StatsInterval
  noun: string
  /** The overlay's view of the queue, when it gives one. */
  assessment?: StatsTileAssessment | null
}

// One queue on /stats: its rates this window, a chart across both, and its share of all arrivals.
// Opens /stats/:queue at the same interval. An overlay may add a badge and a coloured border.
export function StatsTile ({ tile, interval, noun, assessment }: StatsTileProps) {
  const share = formatShare(tile.share)
  const Badge = overlay.slots.statsQueueTile?.Badge
  const severity = assessment?.severity
  return (
    <DbLink
      to={`/stats/${encodeURIComponent(tile.name)}?interval=${interval}`}
      className={cn(
        'group grid gap-2 rounded-[10px] border bg-[var(--surface-card)] px-3.5 pb-2.5 pt-3',
        severity ? SEVERITY_BORDER[severity] : 'border-[var(--border-default)]',
        'transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]'
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate font-medium text-[var(--text-primary)]">{tile.name}</span>
        {Badge && <Badge queue={tile} />}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Rate value={tile.arrivedPerMin} color="var(--stats-arrived)" label="arriving" />
        <Rate value={tile.finishingPerMin} color="var(--stats-finishing)" label="finishing" />
      </div>
      <TileChart points={tile.points} />
      <div className="flex justify-between gap-2 whitespace-nowrap text-[11.5px] text-[var(--text-tertiary)]">
        <span className="truncate">previous {noun} | this {noun}</span>
        {share && <span className="pgb-num">{share}</span>}
      </div>
    </DbLink>
  )
}

interface StatsTileGridProps {
  tiles: StatsQueueSummary[]
  interval: StatsInterval
  noun: string
}

// Small multiples: one tile per queue, busiest first, the first eight until asked for the rest,
// with a name filter for databases with many queues.
export function StatsTileGrid ({ tiles, interval, noun }: StatsTileGridProps) {
  const slot = overlay.slots.statsQueueTile
  const overlaySort = slot?.assess && slot.sortLabel ? slot.sortLabel : null
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [sort, setSort] = useState<'overlay' | 'busiest'>(overlaySort ? 'overlay' : 'busiest')

  // Tiles arrive busiest first. The overlay's order ranks them, busiest first within a rank.
  const assessed = useMemo(
    () => tiles.map((tile) => ({ tile, assessment: slot?.assess?.({ queue: tile }) ?? null })),
    [tiles, slot]
  )
  const ordered = sort === 'overlay'
    ? [...assessed].sort((a, b) => (a.assessment?.rank ?? Infinity) - (b.assessment?.rank ?? Infinity) || byBusiest(a.tile, b.tile))
    : assessed

  const needle = filter.trim().toLowerCase()
  const matching = needle ? ordered.filter(({ tile }) => tile.name.toLowerCase().includes(needle)) : ordered
  const shown = showAll ? matching : matching.slice(0, TILE_LIMIT)

  return (
    <section aria-label="Queues" className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="pgb-eyebrow">Queues</h2>
          <p className="mt-0.5 text-sm text-[var(--text-tertiary)]">Each tile has its own scale. Open one for its rates and backlog.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-tertiary)]">
          {overlaySort
            ? (
              <ToggleGroup
                aria-label="Sort queues"
                value={[sort]}
                onValueChange={(value) => { if (value[0]) setSort(value[0] as 'overlay' | 'busiest') }}
              >
                <ToggleGroupItem value="overlay">{overlaySort}</ToggleGroupItem>
                <ToggleGroupItem value="busiest">Busiest first</ToggleGroupItem>
              </ToggleGroup>
              )
            : <span>Busiest first</span>}
          <div className="relative">
            <input
              type="search"
              aria-label="Filter queues by name"
              placeholder="Filter by name"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className={cn(
                'h-[34px] w-56 rounded-lg border py-1.5 pl-8 pr-3 text-sm shadow-sm',
                'border-[var(--border-strong)] bg-[var(--surface-card)] text-[var(--text-primary)] placeholder-[var(--text-tertiary)]',
                'focus:border-[var(--border-focus)] focus:shadow-[var(--shadow-focus)] focus:outline-none'
              )}
            />
            <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
          </div>
        </div>
      </div>

      {shown.length > 0
        ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
            {shown.map(({ tile, assessment }) => (
              <StatsTile key={tile.name} tile={tile} interval={interval} noun={noun} assessment={assessment} />
            ))}
          </div>
          )
        : (
          <p className="text-sm text-[var(--text-tertiary)]">{needle ? `No queue name contains “${filter.trim()}”.` : 'No queues yet.'}</p>
          )}

      {matching.length > TILE_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="cursor-pointer justify-self-start rounded-[7px] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
        >
          {showAll ? `Show the first ${TILE_LIMIT}` : `Show all ${matching.length.toLocaleString('en-US')} queues`}
        </button>
      )}
    </section>
  )
}
