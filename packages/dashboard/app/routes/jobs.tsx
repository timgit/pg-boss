import { useSearchParams } from 'react-router'
import { ProSlot } from '~/components/pro-slot'
import type { Route } from './+types/jobs'
import {
  getRecentJobs,
  getQueueNames,
  type RecentJobsFilterOptions,
} from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardContent } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '~/components/ui/table'
import { TablePagination } from '~/components/table-pagination'
import { PAGE_SIZE, pageWindow, pageInfo } from '~/lib/pagination'
import { ErrorCard } from '~/components/error-card'
import { QueryTimeoutBanner } from '~/components/query-timeout-banner'
import { JobsFilterBar, type JobsFilters } from '~/components/jobs-filter-bar'
import { JobColumnsEditor } from '~/components/job-columns-editor'
import { JobColumnCell } from '~/components/job-column-cell'
import { isQueryTimeoutError, getQueryTimeoutMs } from '~/lib/db.server'
import type { JobResult } from '~/lib/types'
import {
  DEFAULT_JOB_COLUMNS,
  parseJobColumns,
  appendJobColumns,
  type JobColumn,
} from '~/lib/job-columns'
import {
  isValidJobState,
  DEFAULT_STATE_FILTER,
  ALL_STATES_FILTER,
  parseJsonFilterPairs,
  jsonFilterPairsToObject,
  type JobStateFilter,
} from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: 'Jobs' }

interface ParsedFilters extends JobsFilters {
  serverFilters: RecentJobsFilterOptions
  hasActiveFilters: boolean
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
  // 0 is normalized away: retry_count >= 0 matches every job, so it is no filter at all.
  const minRetries = /^\d+$/.test(minRetriesRaw) && Number(minRetriesRaw) > 0 ? minRetriesRaw : ''

  const dataPairs = parseJsonFilterPairs(searchParams, 'data')
  const outputPairs = parseJsonFilterPairs(searchParams, 'output')
  const dataObject = jsonFilterPairsToObject(dataPairs.filter(p => p.key.trim() && p.value !== ''))
  const outputObject = jsonFilterPairsToObject(outputPairs.filter(p => p.key.trim() && p.value !== ''))

  const hasNarrowingFilters =
    id !== '' ||
    queues.length > 0 ||
    minRetries !== '' ||
    Object.keys(dataObject).length > 0 ||
    Object.keys(outputObject).length > 0

  const hasActiveFilters = hasNarrowingFilters || state !== DEFAULT_STATE_FILTER

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
  }
}

export async function loader ({ request, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  const url = new URL(request.url)
  const parsed = parseFiltersFromUrl(url.searchParams)
  const jobColumns = parseJobColumns(url.searchParams)

  const { page, limit, offset } = pageWindow(url, PAGE_SIZE)

  // No count of the job table, filtered or not: an aggregate over it is a scan of every matching
  // row on a large deployment, and only ever numbered the pages. A full page offers Next, which
  // can land on an empty page when the rows end exactly at a page boundary.
  const [recentJobsResult, queueNames] = await Promise.all([
    getRecentJobs(DB_URL, SCHEMA, {
      ...parsed.serverFilters,
      limit,
      offset,
      jobColumns,
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
  ])

  const recentJobs = recentJobsResult.rows
  const { hasNextPage, hasPrevPage } = pageInfo(page, PAGE_SIZE, recentJobs.length, null)

  return {
    recentJobs,
    queueNames,
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
    jobColumns,
  }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Failed to load jobs" error={error} />
}

// Exported for tests: must round-trip through parseFiltersFromUrl.
export function buildSearchParams (
  filters: JobsFilters
): URLSearchParams {
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

export function buildViewParams (
  jobColumns: JobColumn[] = DEFAULT_JOB_COLUMNS
): URLSearchParams {
  const params = new URLSearchParams()
  appendJobColumns(params, jobColumns)
  return params
}

export function buildParams (
  filters: JobsFilters,
  jobColumns: JobColumn[] = DEFAULT_JOB_COLUMNS
): URLSearchParams {
  const params = buildSearchParams(filters)
  const viewParams = buildViewParams(jobColumns)

  for (const [key, value] of viewParams) {
    params.append(key, value)
  }

  return params
}

export default function Jobs ({ loaderData }: Route.ComponentProps) {
  const {
    recentJobs,
    queueNames,
    page,
    filters,
    hasActiveFilters,
    hasNextPage,
    hasPrevPage,
    timedOut,
    queryTimeoutMs,
    jobColumns,
  } = loaderData
  const [, setSearchParams] = useSearchParams()

  const setQueryParams = (params: URLSearchParams) => {
    const current = new URLSearchParams(window.location.search)
    if (current.has('db')) params.set('db', current.get('db')!)
    setSearchParams(params)
  }

  const getShareUrl = (columns: JobColumn[]) => {
    const params = buildParams(filters, columns)
    const current = new URLSearchParams(window.location.search)
    if (current.has('db')) params.set('db', current.get('db')!)
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`
  }

  const handleFiltersChange = (next: JobsFilters) => {
    setQueryParams(buildParams(next, jobColumns))
  }

  const handleColumnsChange = (columns: JobColumn[]) => {
    setQueryParams(buildParams(filters, columns))
  }

  const clearAll = () => {
    setQueryParams(buildParams({
      state: DEFAULT_STATE_FILTER,
      id: '',
      queues: [],
      minRetries: '',
      data: [],
      output: [],
    }, jobColumns))
  }

  const subtitle = hasActiveFilters
    ? 'Jobs matching these filters, newest first'
    : 'Recently created jobs across all queues'

  return (
    <div className="space-y-4">
      <PageHeader
        title="Jobs"
        subtitle={subtitle}
        action={<ProSlot name="pageActions" page="jobs" />}
      />

      <JobsFilterBar
        filters={filters}
        queueOptions={queueNames}
        onChange={handleFiltersChange}
      />

      <JobColumnsEditor
        columns={jobColumns}
        getShareUrl={getShareUrl}
        onColumnsChange={handleColumnsChange}
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
                {jobColumns.map((col, index) => (
                  <TableHead key={`${col.path}-${index}`}>{col.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="text-center text-[var(--text-tertiary)] py-8"
                    colSpan={jobColumns.length}
                  >
                    No jobs found
                  </TableCell>
                </TableRow>
              ) : (
                recentJobs.map((job: JobResult) => (
                  <TableRow key={job.id} to={`/queues/${encodeURIComponent(job.name)}/jobs/${job.id}`}>
                    {jobColumns.map((col, index) => (
                      <JobColumnCell key={`${col.path}-${index}`} row={job} column={col} />
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>

        <TablePagination
          page={page}
          totalPages={null}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
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
