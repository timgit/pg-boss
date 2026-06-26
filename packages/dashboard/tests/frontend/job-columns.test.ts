import { describe, it, expect } from 'vitest'
import {
  DEFAULT_JOB_COLUMNS,
  DEFAULT_QUEUE_JOB_COLUMNS,
  createJobColumn,
  getRowCellValue,
  jobColumnProp,
  parseJobColumns,
  appendJobColumns,
  type JobColumn,
} from '~/lib/job-columns'
import { buildParams, buildSearchParams, buildViewParams, parseFiltersFromUrl } from '~/routes/jobs'
import { DEFAULT_STATE_FILTER } from '~/lib/utils'
import type { JobsFilters } from '~/components/jobs-filter-bar'

const defaultFilters: JobsFilters = {
  state: DEFAULT_STATE_FILTER,
  id: '',
  queues: [],
  minRetries: '',
  data: [],
  output: [],
}

const advancedFilters: JobsFilters = {
  state: 'failed',
  id: '',
  queues: ['alpha'],
  minRetries: '2',
  data: [{ key: 'tenantId', value: '42' }],
  output: [{ key: 'status', value: 'ok' }],
}

describe('job columns', () => {
  it('resolves to initial columns when URL has no column params', () => {
    expect(parseJobColumns(new URLSearchParams())).toEqual(DEFAULT_JOB_COLUMNS)
  })

  it('supports route-specific default columns', () => {
    const params = new URLSearchParams()
    expect(parseJobColumns(params, DEFAULT_QUEUE_JOB_COLUMNS)).toEqual(DEFAULT_QUEUE_JOB_COLUMNS)

    appendJobColumns(params, DEFAULT_QUEUE_JOB_COLUMNS, DEFAULT_QUEUE_JOB_COLUMNS)
    expect(params.toString()).toBe('')
  })

  it('does not serialize initial columns and filters into the URL', () => {
    const params = buildParams(defaultFilters, DEFAULT_JOB_COLUMNS)
    expect(params.toString()).toBe('')
  })

  it('builds view params separately from filter params', () => {
    const params = buildViewParams([
      { path: 'id', name: 'ID' },
      { path: 'data.tenantId', name: 'Tenant' },
    ])

    expect(params.toString()).toBe('col=id%7CID&col=data.tenantId%7CTenant')
  })

  it('round-trips repeated col params with path and name', () => {
    const columns: JobColumn[] = [
      { path: 'id', name: 'ID' },
      { path: 'data.tenantId', name: 'Tenant' },
      { path: 'output.status', name: 'Status' },
    ]
    const params = buildParams(advancedFilters, columns)

    expect(params.getAll('col')).toEqual([
      'id|ID',
      'data.tenantId|Tenant',
      'output.status|Status',
    ])
    expect(parseJobColumns(params)).toEqual(columns)
    expect(parseFiltersFromUrl(params).state).toBe('failed')
  })

  it('uses the path as the name when col only includes a path', () => {
    const params = new URLSearchParams('col=data.tenant.id')

    expect(parseJobColumns(params)).toEqual([
      { path: 'data.tenant.id', name: 'data.tenant.id' },
    ])
  })

  it('derives row property names from paths', () => {
    expect(jobColumnProp('id')).toBe('id')
    expect(jobColumnProp('data.tenant.id')).toBe('dataTenantId')
    expect(jobColumnProp('output.status')).toBe('outputStatus')

    const row = {
      priority: 0,
      retryCount: 0,
      retryLimit: 0,
      deadLetter: false,
      singletonKey: null,
    }

    expect(getRowCellValue(row, jobColumnProp('priority'))).toBe('0')
    expect(getRowCellValue(row, jobColumnProp('retryCount'))).toBe('0')
    expect(getRowCellValue(row, jobColumnProp('retryLimit'))).toBe('0')
    expect(getRowCellValue(row, jobColumnProp('deadLetter'))).toBe('false')
    expect(getRowCellValue(row, jobColumnProp('singletonKey'))).toBeNull()
  })

  it('ignores invalid column paths and falls back to defaults if none survive', () => {
    expect(createJobColumn('data.')).toBeNull()
    expect(parseJobColumns(new URLSearchParams('col=bad|Bad'))).toEqual(DEFAULT_JOB_COLUMNS)
  })

  it('can write columns into existing params without touching filters', () => {
    const params = buildSearchParams(advancedFilters)
    appendJobColumns(params, [
      { path: 'id', name: 'ID' },
      { path: 'data.tenantId', name: 'Tenant' },
    ])

    expect(params.get('state')).toBe('failed')
    expect(params.getAll('col')).toEqual(['id|ID', 'data.tenantId|Tenant'])
    expect(parseJobColumns(params)).toEqual([
      { path: 'id', name: 'ID' },
      { path: 'data.tenantId', name: 'Tenant' },
    ])
  })
})
