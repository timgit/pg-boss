import { describe, it, expect } from 'vitest'
import { parseFiltersFromUrl, buildSearchParams } from '~/routes/jobs'
import { DEFAULT_STATE_FILTER } from '~/lib/utils'
import type { JobsFilters } from '~/components/jobs-filter-bar'

// parseFiltersFromUrl and buildSearchParams together define the URL contract
// for the Jobs page: every filter state must survive build → parse unchanged,
// and parse must normalize away values that don't narrow anything.

const VALID_UUID = '7c6f6849-1b6f-4afe-95a7-7548e996a417'

function roundTrip (filters: JobsFilters): JobsFilters {
  const parsed = parseFiltersFromUrl(buildSearchParams(filters))
  const { state, id, queues, minRetries, data, output } = parsed
  return { state, id, queues, minRetries, data, output }
}

describe('jobs URL filter round-trip', () => {
  it('serializes default filters to an empty query string', () => {
    const filters: JobsFilters = {
      state: DEFAULT_STATE_FILTER,
      id: '',
      queues: [],
      minRetries: '',
      data: [],
      output: [],
    }
    expect(buildSearchParams(filters).toString()).toBe('')
  })

  it('parses an empty query string to default filters with no count', () => {
    const parsed = parseFiltersFromUrl(new URLSearchParams())
    expect(parsed.state).toBe(DEFAULT_STATE_FILTER)
    expect(parsed.hasActiveFilters).toBe(false)
    expect(parsed.shouldRunCount).toBe(false)
  })

  it('round-trips every filter type unchanged', () => {
    const filters: JobsFilters = {
      state: 'failed',
      id: VALID_UUID,
      queues: ['alpha', 'beta'],
      minRetries: '2',
      data: [{ key: 'sessionId', value: 'abc' }, { key: 'count', value: '3' }],
      output: [{ key: 'status', value: 'ok' }],
    }
    expect(roundTrip(filters)).toEqual(filters)
  })

  it('drops incomplete data/output pairs when serializing', () => {
    const filters: JobsFilters = {
      state: DEFAULT_STATE_FILTER,
      id: '',
      queues: [],
      minRetries: '',
      data: [{ key: 'tenantId', value: '' }, { key: '', value: 'orphan' }],
      output: [],
    }
    expect(buildSearchParams(filters).toString()).toBe('')
  })

  it('normalizes minRetries=0 from the URL to no filter (regression: count gate bypass)', () => {
    const parsed = parseFiltersFromUrl(new URLSearchParams('minRetries=0'))
    expect(parsed.minRetries).toBe('')
    expect(parsed.hasActiveFilters).toBe(false)
    expect(parsed.shouldRunCount).toBe(false)
  })

  it('does not run the count for state=all even with minRetries=0 present', () => {
    expect(parseFiltersFromUrl(new URLSearchParams('state=all&minRetries=0')).shouldRunCount).toBe(false)
  })

  it('collapses duplicate data keys to the value the query uses', () => {
    const parsed = parseFiltersFromUrl(new URLSearchParams('data.k=1&data.k=2'))
    expect(parsed.data).toEqual([{ key: 'k', value: '2' }])
    expect(parsed.serverFilters.data).toEqual({ k: 2 })
  })

  it('never serializes a page parameter', () => {
    const filters: JobsFilters = {
      state: 'completed',
      id: '',
      queues: ['alpha'],
      minRetries: '',
      data: [],
      output: [],
    }
    expect(buildSearchParams(filters).has('page')).toBe(false)
  })
})
