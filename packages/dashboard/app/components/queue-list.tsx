import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { LayoutGrid, List, Search, X } from 'lucide-react'
import { DbLink } from '~/components/db-link'
import { ProSlot } from '~/components/pro-slot'
import { Card, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import { FilterSelect } from '~/components/ui/filter-select'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { Sparkline } from '~/components/ui/sparkline'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableHeader,
} from '~/components/ui/table'
import { TablePagination } from '~/components/table-pagination'
import { cn } from '~/lib/utils'
import { QUEUE_VIEW_COOKIE, type QueueView } from '~/lib/queue-list'
import type { QueueResult } from '~/lib/types'
import type { QueueListData } from '~/lib/queue-list.server'
import { Count } from '~/components/ui/count'
import { formatCompact } from '~/lib/format'

/** One figure in a card's row of three. */
export interface QueueCardFigure {
  value: ReactNode
  label: string
  /** A colour key drawn beside the label. */
  color?: string
}

/** What an overlay changes on one queue's card. Every field is optional. */
export interface QueueCardExtension {
  /** Beside the queue's name. */
  badge?: ReactNode
  /** A red border for critical, amber for watch. */
  severity?: 'critical' | 'watch' | null
  /** In place of ready, active and failed. */
  figures?: QueueCardFigure[]
  /** In place of the ready sparkline. */
  chart?: ReactNode
  /** In place of the queued, deferred and total line. */
  counts?: ReactNode
  /** Lines under the counts. */
  lines?: ReactNode
  /** The card's last line. */
  footer?: ReactNode
}

/** A column an overlay adds to the queue table. */
export interface QueueTableColumn {
  key: string
  header: ReactNode
  /** The column's name for a header that abbreviates it. */
  title?: string
  align?: 'left' | 'right'
  /** The free column it follows. */
  after: 'name' | 'trend'
  cell: (queue: QueueResult) => ReactNode
}

/** A free table column an overlay may leave out. */
export type QueueTableHideable = 'deferred' | 'total' | 'storage'

/** A sort an overlay offers beside the free ones, which it applies to the page itself. */
export interface QueueSortOption {
  value: string
  label: string
}

/**
 * What an overlay that replaces `/queues` adds to the sections it composes. Every field is optional,
 * and without them the page is the free one.
 */
/** A way of drawing the list that an overlay adds beside the cards and the table. */
export interface QueueViewOption {
  value: QueueView
  label: string
  icon?: ReactNode
  render: (queues: QueueResult[]) => ReactNode
}

export interface QueueListExtensions {
  subtitle?: ReactNode
  /** After the free controls in the toolbar. */
  toolbar?: ReactNode
  /** Between the toolbar and the queues. */
  above?: ReactNode
  /** Under the queues and their pagination. */
  below?: ReactNode
  /** Sorts offered before the free ones; the first is the default when the URL names none. */
  sorts?: QueueSortOption[]
  card?: (queue: QueueResult) => QueueCardExtension | undefined
  /** Views of the overlay's own, drawn in place of the cards or the table when chosen. */
  views?: QueueViewOption[]
  table?: {
    columns?: QueueTableColumn[]
    /** In place of the ready sparkline in the Trend column. */
    trend?: (queue: QueueResult) => ReactNode
    hide?: QueueTableHideable[]
  }
}

const FREE_SORTS: QueueSortOption[] = [
  { value: 'ready', label: 'Most ready' },
  { value: 'name', label: 'Name' },
]

/** The direction a sort reads in when chosen from the sort control. */
const SORT_DIRS: Record<string, 'asc' | 'desc'> = { name: 'asc' }

const FILTER_LABELS: Record<string, string> = {
  all: 'All Queues',
  attention: 'Needing Attention',
  partitioned: 'Partitioned',
}

const queueHref = (name: string) => `/queues/${encodeURIComponent(name)}`

/** The sort in effect: the URL's, else the overlay's first, else most ready. */
export function effectiveSort (sort: string | null, extensions?: QueueListExtensions): string {
  return sort ?? extensions?.sorts?.[0]?.value ?? 'ready'
}

function remember (view: QueueView) {
  try {
    document.cookie = `${QUEUE_VIEW_COOKIE}=${view}; path=/; max-age=31536000; samesite=lax`
  } catch {
    // A blocked cookie only costs the remembered choice.
  }
}

const BUILT_IN_VIEWS: Record<string, { label: string, icon: ReactNode }> = {
  cards: { label: 'Cards', icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> },
  table: { label: 'Table', icon: <List className="h-3.5 w-3.5" aria-hidden="true" /> },
}

function ViewToggle ({ views, view, extensions }: { views: QueueView[], view: QueueView, extensions?: QueueListExtensions }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const choose = (next: QueueView) => {
    remember(next)
    const params = new URLSearchParams(searchParams)
    params.set('view', next)
    setSearchParams(params, { preventScrollReset: true })
  }
  return (
    <ToggleGroup aria-label="View" value={[view]} onValueChange={(value) => { if (value[0]) choose(value[0] as QueueView) }}>
      {views.map((value) => {
        const option = extensions?.views?.find((v) => v.value === value) ?? BUILT_IN_VIEWS[value]
        return (
          <ToggleGroupItem key={value} value={value} className="inline-flex items-center gap-1.5">
            {option?.icon}
            {option?.label ?? value}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

function Toolbar ({ data, extensions }: { data: QueueListData, extensions?: QueueListExtensions }) {
  const { filter, search } = data
  const [searchParams, setSearchParams] = useSearchParams()
  const [searchInput, setSearchInput] = useState(search)
  useEffect(() => { setSearchInput(search) }, [search])

  const update = (change: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams)
    change(params)
    params.delete('page')
    setSearchParams(params)
  }
  const applySearch = (value: string) => update((p) => { if (value.trim()) p.set('search', value.trim()); else p.delete('search') })
  const applyFilter = (value: string) => update((p) => { if (value === 'all') p.delete('filter'); else p.set('filter', value) })
  const sorts = [...(extensions?.sorts ?? []), ...FREE_SORTS]
  const sort = effectiveSort(data.sort, extensions)
  const applySort = (value: string) => update((p) => {
    p.set('sort', value)
    p.set('dir', SORT_DIRS[value] ?? 'desc')
  })
  const hasActiveFilters = filter !== 'all' || search

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative min-w-0 flex-1">
          <input
            type="search"
            aria-label="Search queues by name"
            placeholder="Search queues by name..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applySearch(searchInput) }}
            className={cn(
              'h-[38px] w-full rounded-lg border py-2 pl-10 pr-3 text-sm shadow-sm',
              'border-[var(--border-strong)] bg-[var(--surface-card)] text-[var(--text-primary)] placeholder-[var(--text-tertiary)]',
              'focus:border-[var(--border-focus)] focus:shadow-[var(--shadow-focus)] focus:outline-none'
            )}
          />
          <Search aria-hidden="true" className="absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[var(--text-tertiary)]" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            value={filter}
            options={Object.entries(FILTER_LABELS).map(([value, label]) => ({ value, label }))}
            onChange={applyFilter}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-tertiary)]">Sort</span>
            <ToggleGroup aria-label="Sort queues" value={[sort]} onValueChange={(value) => { if (value[0]) applySort(value[0]) }}>
              {sorts.map((s) => <ToggleGroupItem key={s.value} value={s.value}>{s.label}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
          {extensions?.toolbar}
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-[var(--text-tertiary)]">Active filters:</span>
          {filter !== 'all' && (
            <Badge variant="primary" size="sm">
              {FILTER_LABELS[filter]}
              <button type="button" aria-label="Clear the filter" onClick={() => applyFilter('all')} className="ml-1 cursor-pointer">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </Badge>
          )}
          {search && (
            <Badge variant="primary" size="sm">
              Search: {search}
              <button type="button" aria-label="Clear the search" onClick={() => applySearch('')} className="ml-1 cursor-pointer">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </Badge>
          )}
          <button
            type="button"
            onClick={() => { setSearchInput(''); update((p) => { p.delete('search'); p.delete('filter') }) }}
            className="cursor-pointer text-sm text-[var(--primary-600)] dark:text-[var(--primary-400)] hover:text-[var(--primary-700)] dark:hover:text-[var(--primary-300)]"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}

const CHART_W = 240
const CHART_H = 48

/**
 * The ready count over the last 60 monitor passes (an hour at the default interval), from
 * `queue.ready_history`, which every pass keeps whatever `persistQueueStats` says. Plain SVG, so it
 * renders on the server with the card.
 */
export function ReadyChart ({ history }: { history: number[] | null | undefined }) {
  // Stored newest first.
  const values = history ? [...history].reverse() : []
  if (values.length < 2) {
    return <div className="flex h-12 items-center text-xs text-[var(--text-tertiary)]">No ready history yet</div>
  }
  const top = Math.max(1, ...values)
  const x = (i: number) => (i / (values.length - 1)) * CHART_W
  const y = (v: number) => CHART_H - 1 - (v / top) * (CHART_H - 6)
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <div className="relative pt-3.5">
      <span className="pgb-num absolute left-0 top-0 text-[10px] text-[var(--text-tertiary)]">last hour</span>
      <span className="pgb-num absolute right-0 top-0 text-[10px] text-[var(--stats-ready)]">{formatCompact(top)}</span>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="block h-12 w-full" aria-hidden="true">
        <polygon points={`0,${CHART_H} ${line} ${CHART_W},${CHART_H}`} fill="var(--stats-ready)" opacity={0.14} />
        <polyline points={line} fill="none" stroke="var(--stats-ready)" strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={CHART_W} y1={CHART_H - 0.5} y2={CHART_H - 0.5} stroke="var(--border-default)" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

const SEVERITY_BORDER = {
  critical: 'border-[var(--error-500)]',
  watch: 'border-[var(--warning-500)]',
}

function Figure ({ figure }: { figure: QueueCardFigure }) {
  return (
    <div className="min-w-0">
      <b className="pgb-num block text-base font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{figure.value}</b>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-[var(--text-tertiary)]">
        {figure.color && <span aria-hidden="true" className="inline-block h-0.5 w-2 rounded-full" style={{ background: figure.color }} />}
        {figure.label}
      </span>
    </div>
  )
}

const n = (value: number) => value.toLocaleString('en-US')

/** One queue as a card: three figures, a chart, its counts, and whatever an overlay adds. Opens its page. */
export function QueueCard ({ queue, extension }: { queue: QueueResult, extension?: QueueCardExtension }) {
  const figures = extension?.figures ?? [
    { value: <Count value={queue.readyCount} />, label: 'ready', color: 'var(--stats-ready)' },
    { value: <Count value={queue.activeCount} />, label: 'active' },
    { value: <Count value={queue.failedCount} />, label: 'failed' },
  ]
  const severity = extension?.severity
  return (
    <DbLink
      to={queueHref(queue.name)}
      className={cn(
        // The card gradient, as every Card has: a solid fill reads darker beside them in dark mode.
        'group grid content-start gap-2 rounded-[10px] border [background:var(--surface-card-grad)] px-3.5 pb-2.5 pt-3',
        severity ? SEVERITY_BORDER[severity] : 'border-[var(--border-default)]',
        'transition-colors hover:[background:var(--surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]'
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate font-medium text-[var(--text-primary)]">{queue.name}</span>
        {extension?.badge}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {figures.map((f) => <Figure key={f.label} figure={f} />)}
      </div>
      {extension?.chart ?? <ReadyChart history={queue.readyHistory} />}
      <div className="pgb-num text-[11.5px] text-[var(--text-tertiary)]">
        {extension?.counts ?? `queued ${formatCompact(queue.queuedCount)} · deferred ${formatCompact(queue.deferredCount)} · total ${formatCompact(queue.totalCount)}`}
      </div>
      {extension?.lines}
      {extension?.footer}
    </DbLink>
  )
}

/** Every queue on the page as a card. */
export function QueueCards ({ queues, extensions }: { queues: QueueResult[], extensions?: QueueListExtensions }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
      {queues.map((queue) => <QueueCard key={queue.name} queue={queue} extension={extensions?.card?.(queue)} />)}
    </div>
  )
}

function ExtraHeads ({ columns }: { columns: QueueTableColumn[] }) {
  return (
    <>
      {columns.map((c) => (
        <TableHead key={c.key} className={cn('whitespace-nowrap', c.align === 'right' && 'text-right')}>
          {c.title ? <span title={c.title}>{c.header}</span> : c.header}
        </TableHead>
      ))}
    </>
  )
}

function ExtraCells ({ columns, queue }: { columns: QueueTableColumn[], queue: QueueResult }) {
  return (
    <>
      {columns.map((c) => (
        <TableCell key={c.key} className={cn(c.align === 'right' && 'pgb-num text-right')}>{c.cell(queue)}</TableCell>
      ))}
    </>
  )
}

const numCell = 'pgb-num text-right text-[var(--text-primary)]'

/** Every queue on the page as a table row, with the columns an overlay adds. */
export function QueueTable ({ queues, extensions }: { queues: QueueResult[], extensions?: QueueListExtensions }) {
  const columns = extensions?.table?.columns ?? []
  const afterName = columns.filter((c) => c.after === 'name')
  const afterTrend = columns.filter((c) => c.after === 'trend')
  const hidden = new Set(extensions?.table?.hide ?? [])
  const trend = extensions?.table?.trend
  const span = 7 + columns.length + (['deferred', 'total', 'storage'] as const).filter((k) => !hidden.has(k)).length

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHeader column="name">Name</SortableHeader>
          <ExtraHeads columns={afterName} />
          <SortableHeader column="ready" align="right">Ready</SortableHeader>
          <TableHead className="w-32">Trend</TableHead>
          <ExtraHeads columns={afterTrend} />
          <SortableHeader column="queued" align="right">Queued</SortableHeader>
          {!hidden.has('deferred') && <SortableHeader column="deferred" align="right">Deferred</SortableHeader>}
          <SortableHeader column="active" align="right">Active</SortableHeader>
          <SortableHeader column="failed" align="right">Failed</SortableHeader>
          {!hidden.has('total') && <SortableHeader column="total" align="right">Total</SortableHeader>}
          <SortableHeader column="policy" className="w-28">Policy</SortableHeader>
          {!hidden.has('storage') && <SortableHeader column="storage" className="w-28">Storage</SortableHeader>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {queues.length === 0
          ? (
            <TableRow>
              <TableCell className="py-8 text-center text-[var(--text-tertiary)]" colSpan={span}>No queues found</TableCell>
            </TableRow>
            )
          : queues.map((queue) => (
            <TableRow key={queue.name} to={queueHref(queue.name)}>
              <TableCell>
                <DbLink to={queueHref(queue.name)} className="font-medium text-[var(--primary-600)] dark:text-[var(--primary-400)] hover:text-[var(--primary-700)] dark:hover:text-[var(--primary-300)]">
                  {queue.name}
                </DbLink>
              </TableCell>
              <ExtraCells columns={afterName} queue={queue} />
              <TableCell className={numCell}>{n(queue.readyCount)}</TableCell>
              <TableCell>
                {trend
                  ? trend(queue)
                  : queue.readyHistory && queue.readyHistory.length > 0
                    ? (
                      <Sparkline
                        // Stored newest first.
                        data={[...queue.readyHistory].reverse()}
                        width={96}
                        height={20}
                        color="var(--stats-ready)"
                        showDot={false}
                        area
                        aria-label={`Ready count over the last hour for ${queue.name}`}
                      />
                      )
                    : <span className="text-[var(--border-strong)]">—</span>}
              </TableCell>
              <ExtraCells columns={afterTrend} queue={queue} />
              <TableCell className={numCell}>{n(queue.queuedCount)}</TableCell>
              {!hidden.has('deferred') && <TableCell className={numCell}>{n(queue.deferredCount)}</TableCell>}
              <TableCell className={numCell}>{n(queue.activeCount)}</TableCell>
              <TableCell className={numCell}>{n(queue.failedCount)}</TableCell>
              {!hidden.has('total') && <TableCell className={numCell}>{n(queue.totalCount)}</TableCell>}
              <TableCell><Badge variant="gray" size="sm">{queue.policy}</Badge></TableCell>
              {!hidden.has('storage') && <TableCell className="text-[var(--text-secondary)]">{queue.partition ? 'Partitioned' : 'Shared'}</TableCell>}
            </TableRow>
          ))}
      </TableBody>
    </Table>
  )
}

/** The page's title, its subtitle, the overlay's actions and the view toggle. */
export function QueueListHeader ({ data, extensions }: { data: QueueListData, extensions?: QueueListExtensions }) {
  const { totalCount, filter, search, view } = data
  const filtered = filter !== 'all' || !!search
  return (
    <PageHeader
      title="Queues"
      subtitle={extensions?.subtitle ?? `${n(totalCount)} queue${totalCount !== 1 ? 's' : ''} ${filtered ? 'found' : 'configured'}`}
      action={
        // The view toggle sits under the page's own action, so the action keeps its place whichever view is chosen.
        <div className="flex flex-col items-end gap-2">
          <ProSlot name="pageActions" page="queues" />
          {data.views.length > 1 && <ViewToggle views={data.views} view={view} extensions={extensions} />}
        </div>
      }
    />
  )
}

/**
 * Everything under the header: the toolbar, the queues as cards or a table, and their pagination.
 * An overlay that replaces `/queues` composes it with its own `extensions`.
 */
export function QueueListSections ({ data, extensions }: { data: QueueListData, extensions?: QueueListExtensions }) {
  const { queues, view, page, totalPages, hasNextPage, hasPrevPage, totalCount, pageSize } = data
  // Anything but the table is laid out the same way: the overlay's own view, or the cards.
  const drawn = extensions?.views?.find((v) => v.value === view)?.render ??
    (view === 'cards' ? (list: QueueResult[]) => <QueueCards queues={list} extensions={extensions} /> : null)
  const pagination = (
    <TablePagination
      page={page}
      totalPages={totalPages}
      hasNextPage={hasNextPage}
      hasPrevPage={hasPrevPage}
      totalCount={totalCount}
      pageSize={pageSize}
    />
  )
  return (
    <div className="space-y-4">
      <Toolbar data={data} extensions={extensions} />
      {extensions?.above}
      {drawn
        ? (
          <section aria-label="Queues" className="space-y-3">
            {queues.length > 0
              ? drawn(queues)
              : <Card><CardContent className="py-8 text-center text-[var(--text-tertiary)]">No queues found</CardContent></Card>}
            {totalPages != null && totalPages > 1 && <Card>{pagination}</Card>}
          </section>
          )
        : (
          <Card>
            <CardContent className="p-0">
              <QueueTable queues={queues} extensions={extensions} />
            </CardContent>
            {pagination}
          </Card>
          )}
      {extensions?.below}
    </div>
  )
}

/** The free page whole, for an overlay that wants it as it is. */
export function QueueList ({ data, extensions }: { data: QueueListData, extensions?: QueueListExtensions }) {
  return (
    <div className="space-y-4">
      <QueueListHeader data={data} extensions={extensions} />
      <QueueListSections data={data} extensions={extensions} />
    </div>
  )
}
