import { useSearchParams } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/jobs'
import {
  getRecentJobs,
  getRecentJobsCount,
  getQueueNames,
  type RecentJobsFilterOptions,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '~/components/ui/table'
import { Pagination } from '~/components/ui/pagination'
import { ErrorCard } from '~/components/error-card'
import { QueryTimeoutBanner } from '~/components/query-timeout-banner'
import { JobsFilterBar, type JobsFilters } from '~/components/jobs-filter-bar'
import { isQueryTimeoutError, getQueryTimeoutMs } from '~/lib/db.server'
import type { JobResult } from '~/lib/types'
import {
  parsePageNumber,
  formatDate,
  JOB_STATE_VARIANTS,
  isValidJobState,
  DEFAULT_STATE_FILTER,
  ALL_STATES_FILTER,
  parseJsonFilterPairs,
  jsonFilterPairsToObject,
  type JobStateFilter,
} from '~/lib/utils'

interface ParsedFilters extends JobsFilters {
  serverFilters: RecentJobsFilterOptions
  hasActiveFilters: boolean
  shouldRunCount: boolean
}

// Exported for tests: buildSearchParams must round-trip through this parser.
export function parseFiltersFromUrl (searchParams: URLSearchParams): ParsedFilters {
  const stateParam = searchParams.get('state')
  const state: JobStateFilter = stateParam !== null && isValidJobState(stateParam)
    ? (stateParam as JobStateFilter)
    : DEFAULT_STATE_FILTER

  const id = (searchParams.get('id') || '').trim()
  const queuesRaw = (searchParams.get('queues') || '').trim()
  const queues = queuesRaw ? queuesRaw.split(',').filter(Boolean) : []
  const minRetriesRaw = (searchParams.get('minRetries') || '').trim()
  // 0 is normalized away: retry_count >= 0 matches every job, but a non-empty
  // value here would still flip hasNarrowingFilters and trigger an unbounded
  // COUNT(*) even though buildRecentJobsWhere adds no condition for it.
  const minRetries = /^\d+$/.test(minRetriesRaw) && Number(minRetriesRaw) > 0 ? minRetriesRaw : ''

  const dataPairs = parseJsonFilterPairs(searchParams, 'data')
  const outputPairs = parseJsonFilterPairs(searchParams, 'output')
  const dataObject = jsonFilterPairsToObject(dataPairs.filter(p => p.key && p.value !== ''))
  const outputObject = jsonFilterPairsToObject(outputPairs.filter(p => p.key && p.value !== ''))

  // Cosmetic vs cost-bearing distinction:
  //   hasActiveFilters drives the "X jobs found" subtitle and the chip strip.
  //   shouldRunCount gates the COUNT(*) — we only run it when there's a WHERE
  //   that actually shrinks the scan. state='all' alone adds no WHERE and would
  //   force a full table scan to count every row, which is exactly what we
  //   wanted to avoid by skipping the count for the default view.
  const hasNarrowingFilters =
    id !== '' ||
    queues.length > 0 ||
    minRetries !== '' ||
    Object.keys(dataObject).length > 0 ||
    Object.keys(outputObject).length > 0

  const hasActiveFilters = hasNarrowingFilters || state !== DEFAULT_STATE_FILTER
  const shouldRunCount = hasNarrowingFilters || (state !== DEFAULT_STATE_FILTER && state !== 'all')

  const serverFilters: RecentJobsFilterOptions = {
    state,
    id: id || null,
    queues: queues.length > 0 ? queues : null,
    minRetries: minRetries !== '' ? Number(minRetries) : null,
    data: Object.keys(dataObject).length > 0 ? dataObject : null,
    output: Object.keys(outputObject).length > 0 ? outputObject : null,
  }

  return {
    state,
    id,
    queues,
    minRetries,
    data: dataPairs,
    output: outputPairs,
    serverFilters,
    hasActiveFilters,
    shouldRunCount,
  }
}

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const parsed = parseFiltersFromUrl(url.searchParams)

  const page = parsePageNumber(url.searchParams.get('page'))
  const limit = 20
  const offset = (page - 1) * limit

  const [recentJobsResult, queueNames, totalCount] = await Promise.all([
    getRecentJobs(DB_URL, SCHEMA, {
      ...parsed.serverFilters,
      limit,
      offset,
    }).then(
      (rows) => ({ rows, timedOut: false }),
      (err) => {
        // A cancelled list query (statement_timeout) is an expected outcome on
        // large tables with broad filters — render an inline banner instead of
        // the ErrorBoundary so the user can remove the expensive filter.
        if (isQueryTimeoutError(err)) return { rows: [] as JobResult[], timedOut: true }
        throw err
      }
    ),
    getQueueNames(DB_URL, SCHEMA),
    // Count is best-effort: a failure here would block the entire page even
    // though the result list already loaded. Degrade to a null count so the
    // subtitle silently falls back to the next-page heuristic.
    parsed.shouldRunCount
      ? getRecentJobsCount(DB_URL, SCHEMA, parsed.serverFilters)
        .catch(() => null)
      : Promise.resolve<number | null>(null),
  ])

  const recentJobs = recentJobsResult.rows
  const hasNextPage = !recentJobsResult.timedOut && (totalCount != null
    ? page * limit < totalCount
    : recentJobs.length === limit)
  const hasPrevPage = page > 1

  return {
    recentJobs,
    queueNames,
    totalCount,
    page,
    timedOut: recentJobsResult.timedOut,
    queryTimeoutMs: getQueryTimeoutMs(),
    filters: {
      state: parsed.state,
      id: parsed.id,
      queues: parsed.queues,
      minRetries: parsed.minRetries,
      data: parsed.data,
      output: parsed.output,
    } satisfies JobsFilters,
    hasActiveFilters: parsed.hasActiveFilters,
    hasNextPage,
    hasPrevPage,
  }
}

export function ErrorBoundary () {
  return <ErrorCard title="Failed to load jobs" />
}

// Exported for tests: must round-trip through parseFiltersFromUrl.
export function buildSearchParams (filters: JobsFilters): URLSearchParams {
  const params = new URLSearchParams()

  if (filters.state !== DEFAULT_STATE_FILTER) {
    params.set('state', filters.state)
  }
  if (filters.id) params.set('id', filters.id)
  if (filters.queues.length > 0) params.set('queues', filters.queues.join(','))
  if (filters.minRetries) params.set('minRetries', filters.minRetries)
  for (const pair of filters.data) {
    if (pair.key && pair.value !== '') params.append(`data.${pair.key}`, pair.value)
  }
  for (const pair of filters.output) {
    if (pair.key && pair.value !== '') params.append(`output.${pair.key}`, pair.value)
  }

  return params
}

export default function Jobs ({ loaderData }: Route.ComponentProps) {
  const {
    recentJobs,
    queueNames,
    totalCount,
    page,
    filters,
    hasActiveFilters,
    hasNextPage,
    hasPrevPage,
    timedOut,
    queryTimeoutMs,
  } = loaderData
  const [, setSearchParams] = useSearchParams()

  const handleFiltersChange = (next: JobsFilters) => {
    setSearchParams(buildSearchParams(next))
  }

  const handlePageChange = (newPage: number) => {
    const params = buildSearchParams(filters)
    if (newPage > 1) params.set('page', newPage.toString())
    setSearchParams(params)
  }

  const clearAll = () => {
    setSearchParams(new URLSearchParams())
  }

  const subtitle = hasActiveFilters && totalCount != null
    ? `${totalCount.toLocaleString()} job${totalCount === 1 ? '' : 's'} found`
    : 'Recently created jobs across all queues'

  return (
    <div className="space-y-4">
      <PageHeader
        title="Jobs"
        subtitle={subtitle}
        action={
          <DbLink to="/send">
            <Button variant="primary" size="md">Send Job</Button>
          </DbLink>
        }
      />

      <JobsFilterBar
        filters={filters}
        queueOptions={queueNames}
        onChange={handleFiltersChange}
      />

      {hasActiveFilters && (
        <ActiveFilterChips
          filters={filters}
          onChange={handleFiltersChange}
          onClearAll={clearAll}
        />
      )}

      {timedOut && <QueryTimeoutBanner timeoutMs={queryTimeoutMs} />}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Queue</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Retries</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.length === 0 ? (
                <TableRow>
                  <TableCell className="text-center text-[var(--text-tertiary)] py-8" colSpan={5}>
                    No jobs found
                  </TableCell>
                </TableRow>
              ) : (
                recentJobs.map((job: JobResult) => (
                  <TableRow key={job.id} to={`/queues/${encodeURIComponent(job.name)}/jobs/${job.id}`}>
                    <TableCell>
                      <DbLink
                        to={`/queues/${encodeURIComponent(job.name)}/jobs/${job.id}`}
                        className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                      >
                        {job.id}
                      </DbLink>
                    </TableCell>
                    <TableCell className="font-medium text-[var(--text-secondary)]">
                      {job.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant={JOB_STATE_VARIANTS[job.state]} size="sm" dot>
                        {job.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="pgb-num text-[var(--text-primary)]">
                      {job.retryCount} / {job.retryLimit}
                    </TableCell>
                    <TableCell className="pgb-num text-[var(--text-tertiary)]">
                      {formatDate(new Date(job.createdOn))}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <Pagination
          page={page}
          totalPages={null}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
          onPageChange={handlePageChange}
        />
      </Card>
    </div>
  )
}

interface ActiveFilterChipsProps {
  filters: JobsFilters
  onChange: (next: JobsFilters) => void
  onClearAll: () => void
}

function ActiveFilterChips ({ filters, onChange, onClearAll }: ActiveFilterChipsProps) {
  const stateLabel = filters.state === ALL_STATES_FILTER
    ? 'All States'
    : filters.state.charAt(0).toUpperCase() + filters.state.slice(1)

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-gray-500 dark:text-gray-400">Active filters:</span>

      {filters.state !== DEFAULT_STATE_FILTER && (
        <Chip
          label={`State: ${stateLabel}`}
          onRemove={() => onChange({ ...filters, state: DEFAULT_STATE_FILTER })}
        />
      )}

      {filters.id && (
        <Chip
          label={`ID: ${filters.id}`}
          onRemove={() => onChange({ ...filters, id: '' })}
        />
      )}

      {filters.queues.map((q) => (
        <Chip
          key={q}
          label={`Queue: ${q}`}
          onRemove={() => onChange({ ...filters, queues: filters.queues.filter(x => x !== q) })}
        />
      ))}

      {filters.minRetries && (
        <Chip
          label={`Retries ≥ ${filters.minRetries}`}
          onRemove={() => onChange({ ...filters, minRetries: '' })}
        />
      )}

      {filters.data
        .filter(p => p.key && p.value !== '')
        .map((p, i) => (
          <Chip
            key={`data-${p.key}-${i}`}
            label={`data.${p.key}=${p.value}`}
            onRemove={() => onChange({
              ...filters,
              data: filters.data.filter((x) => !(x.key === p.key && x.value === p.value)),
            })}
          />
        ))}

      {filters.output
        .filter(p => p.key && p.value !== '')
        .map((p, i) => (
          <Chip
            key={`output-${p.key}-${i}`}
            label={`output.${p.key}=${p.value}`}
            onRemove={() => onChange({
              ...filters,
              output: filters.output.filter((x) => !(x.key === p.key && x.value === p.value)),
            })}
          />
        ))}

      <button
        type="button"
        onClick={onClearAll}
        className="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 cursor-pointer"
      >
        Clear all
      </button>
    </div>
  )
}

function Chip ({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge variant="primary" size="sm">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="ml-1 hover:text-primary-700 cursor-pointer"
      >
        ×
      </button>
    </Badge>
  )
}
