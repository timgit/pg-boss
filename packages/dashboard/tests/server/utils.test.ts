import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parsePageNumber,
  formatTimeAgo,
  formatTimeUntil,
  formatDate,
  formatDateWithSeconds,
  formatWarningData,
  isValidJobState,
  isValidWarningType,
  isValidBamStatus,
  JOB_STATES,
  WARNING_TYPES,
  BAM_STATUSES,
  BAM_STATUS_VARIANTS,
  BAM_STATUS_OPTIONS,
  appendSearchParamPairs,
  parseJsonFilterPairs,
  parseSearchParamPairs,
  jsonFilterPairsToObject,
  MAX_JSON_FILTER_PAIRS,
} from '~/lib/utils'

describe('utils', () => {
  describe('parsePageNumber', () => {
    it('returns 1 for null', () => {
      expect(parsePageNumber(null)).toBe(1)
    })

    it('returns 1 for empty string', () => {
      expect(parsePageNumber('')).toBe(1)
    })

    it('returns 1 for non-numeric string', () => {
      expect(parsePageNumber('abc')).toBe(1)
      expect(parsePageNumber('page1')).toBe(1)
    })

    it('returns 1 for zero', () => {
      expect(parsePageNumber('0')).toBe(1)
    })

    it('returns 1 for negative numbers', () => {
      expect(parsePageNumber('-1')).toBe(1)
      expect(parsePageNumber('-100')).toBe(1)
    })

    it('returns valid positive integers', () => {
      expect(parsePageNumber('1')).toBe(1)
      expect(parsePageNumber('5')).toBe(5)
      expect(parsePageNumber('100')).toBe(100)
    })

    it('returns 1 for decimal numbers', () => {
      expect(parsePageNumber('1.5')).toBe(1)
      expect(parsePageNumber('2.9')).toBe(2)
    })

    it('parses strings with leading zeros', () => {
      expect(parsePageNumber('01')).toBe(1)
      expect(parsePageNumber('007')).toBe(7)
    })
  })

  describe('formatTimeAgo', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("returns 'just now' for dates less than 60 seconds ago", () => {
      const date = new Date('2024-01-15T11:59:30Z') // 30 seconds ago
      expect(formatTimeAgo(date)).toBe('just now')
    })

    it('returns minutes ago for dates less than 1 hour ago', () => {
      const date = new Date('2024-01-15T11:30:00Z') // 30 minutes ago
      expect(formatTimeAgo(date)).toBe('30m ago')
    })

    it('returns hours ago for dates less than 1 day ago', () => {
      const date = new Date('2024-01-15T06:00:00Z') // 6 hours ago
      expect(formatTimeAgo(date)).toBe('6h ago')
    })

    it('returns days ago for dates more than 1 day ago', () => {
      const date = new Date('2024-01-12T12:00:00Z') // 3 days ago
      expect(formatTimeAgo(date)).toBe('3d ago')
    })
  })

  describe('formatTimeUntil', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("returns 'now' for past or current dates", () => {
      expect(formatTimeUntil(new Date('2024-01-15T11:59:30Z'))).toBe('now')
    })

    it("returns 'in <1m' for dates less than 60 seconds away", () => {
      expect(formatTimeUntil(new Date('2024-01-15T12:00:30Z'))).toBe('in <1m')
    })

    it('returns minutes for dates less than 1 hour away', () => {
      expect(formatTimeUntil(new Date('2024-01-15T12:30:00Z'))).toBe('in 30m')
    })

    it('returns hours for dates less than 1 day away', () => {
      expect(formatTimeUntil(new Date('2024-01-15T18:00:00Z'))).toBe('in 6h')
    })

    it('returns days for dates more than 1 day away', () => {
      expect(formatTimeUntil(new Date('2024-01-18T12:00:00Z'))).toBe('in 3d')
    })
  })

  describe('formatDate', () => {
    it('formats a date with month, day, hour, and minute', () => {
      const date = new Date('2024-06-15T14:30:00Z')
      const formatted = formatDate(date)

      // The exact output depends on locale, but should include key parts
      expect(formatted).toBeTruthy()
      expect(typeof formatted).toBe('string')
    })
  })

  describe('formatDateWithSeconds', () => {
    it('formats a date with month, day, hour, minute, and second', () => {
      const date = new Date('2024-06-15T14:30:45Z')
      const formatted = formatDateWithSeconds(date)

      expect(formatted).toBeTruthy()
      expect(typeof formatted).toBe('string')
    })
  })

  describe('isValidJobState', () => {
    it('returns true for null (no filter)', () => {
      expect(isValidJobState(null)).toBe(true)
    })

    it('returns true for all valid states', () => {
      for (const state of JOB_STATES) {
        expect(isValidJobState(state)).toBe(true)
      }
    })

    it('returns true for special filters (pending, all)', () => {
      expect(isValidJobState('pending')).toBe(true)
      expect(isValidJobState('all')).toBe(true)
    })

    it('returns false for invalid states', () => {
      expect(isValidJobState('invalid')).toBe(false)
      expect(isValidJobState('CREATED')).toBe(false)
      expect(isValidJobState('PENDING')).toBe(false)
      expect(isValidJobState('')).toBe(false)
    })
  })

  describe('isValidWarningType', () => {
    it('returns true for null (no filter)', () => {
      expect(isValidWarningType(null)).toBe(true)
    })

    it('returns true for all valid types', () => {
      for (const type of WARNING_TYPES) {
        expect(isValidWarningType(type)).toBe(true)
      }
    })

    it('returns false for invalid types', () => {
      expect(isValidWarningType('invalid')).toBe(false)
      expect(isValidWarningType('SLOW_QUERY')).toBe(false)
      expect(isValidWarningType('error')).toBe(false)
      expect(isValidWarningType('')).toBe(false)
    })
  })

  describe('JOB_STATES constant', () => {
    it('contains all expected states', () => {
      expect(JOB_STATES).toContain('created')
      expect(JOB_STATES).toContain('retry')
      expect(JOB_STATES).toContain('active')
      expect(JOB_STATES).toContain('completed')
      expect(JOB_STATES).toContain('cancelled')
      expect(JOB_STATES).toContain('failed')
      expect(JOB_STATES).toHaveLength(6)
    })
  })

  describe('WARNING_TYPES constant', () => {
    it('contains all expected types', () => {
      expect(WARNING_TYPES).toContain('slow_query')
      expect(WARNING_TYPES).toContain('queue_backlog')
      expect(WARNING_TYPES).toContain('clock_skew')
      expect(WARNING_TYPES).toHaveLength(3)
    })
  })

  describe('isValidBamStatus', () => {
    it('returns true for null (no filter)', () => {
      expect(isValidBamStatus(null)).toBe(true)
    })

    it('returns true for all valid statuses', () => {
      for (const status of BAM_STATUSES) {
        expect(isValidBamStatus(status)).toBe(true)
      }
    })

    it('returns false for invalid statuses', () => {
      expect(isValidBamStatus('invalid')).toBe(false)
      expect(isValidBamStatus('PENDING')).toBe(false)
      expect(isValidBamStatus('done')).toBe(false)
      expect(isValidBamStatus('')).toBe(false)
    })
  })

  describe('BAM_STATUSES constant', () => {
    it('contains all expected statuses', () => {
      expect(BAM_STATUSES).toContain('pending')
      expect(BAM_STATUSES).toContain('in_progress')
      expect(BAM_STATUSES).toContain('completed')
      expect(BAM_STATUSES).toContain('failed')
      expect(BAM_STATUSES).toHaveLength(4)
    })

    it('has a badge variant for every status', () => {
      for (const status of BAM_STATUSES) {
        expect(BAM_STATUS_VARIANTS[status]).toBeDefined()
      }
    })

    it('exposes a null "all" option plus one option per status', () => {
      expect(BAM_STATUS_OPTIONS[0].value).toBeNull()
      expect(BAM_STATUS_OPTIONS).toHaveLength(BAM_STATUSES.length + 1)
    })
  })

  describe('formatWarningData', () => {
    it('returns dash for null/undefined', () => {
      expect(formatWarningData(null)).toBe('-')
      expect(formatWarningData(undefined)).toBe('-')
    })

    it('returns string as-is', () => {
      expect(formatWarningData('some message')).toBe('some message')
    })

    it('formats elapsed time', () => {
      expect(formatWarningData({ elapsed: 1.234 })).toBe('1.23s')
    })

    it('formats queue name', () => {
      expect(formatWarningData({ name: 'my-queue' })).toBe('queue: my-queue')
    })

    it('formats queued count', () => {
      expect(formatWarningData({ queuedCount: 100 })).toBe('queued: 100')
    })

    it('formats clock skew', () => {
      expect(formatWarningData({ seconds: 5.678, direction: 'ahead' })).toBe('skew: 5.7s, (ahead)')
    })

    it('combines multiple fields', () => {
      const data = { elapsed: 2.5, name: 'test-queue', queuedCount: 50 }
      expect(formatWarningData(data)).toBe('2.50s, queue: test-queue, queued: 50')
    })

    it('returns JSON for unknown object structure', () => {
      const data = { unknownField: 'value' }
      expect(formatWarningData(data)).toBe('{"unknownField":"value"}')
    })
  })

  describe('parseJsonFilterPairs', () => {
    it('returns an empty list when no matching params exist', () => {
      const params = new URLSearchParams('foo=bar&state=active')
      expect(parseJsonFilterPairs(params, 'data')).toEqual([])
    })

    it('extracts pairs for the requested prefix only', () => {
      const params = new URLSearchParams('data.sessionId=abc&data.tier=hi&output.status=ok')
      expect(parseJsonFilterPairs(params, 'data')).toEqual([
        { key: 'sessionId', value: 'abc' },
        { key: 'tier', value: 'hi' },
      ])
      expect(parseJsonFilterPairs(params, 'output')).toEqual([
        { key: 'status', value: 'ok' },
      ])
    })

    it('skips entries whose key is empty after the prefix', () => {
      const params = new URLSearchParams('data.=lonely')
      expect(parseJsonFilterPairs(params, 'data')).toEqual([])
    })

    it('collapses duplicate keys to the last value, keeping first position', () => {
      // Must agree with jsonFilterPairsToObject (last-wins) so the UI never
      // shows a row or chip for a value the @> query ignores.
      const params = new URLSearchParams('data.k=1&data.other=x&data.k=2')
      expect(parseJsonFilterPairs(params, 'data')).toEqual([
        { key: 'k', value: '2' },
        { key: 'other', value: 'x' },
      ])
    })

    it(`caps the result at MAX_JSON_FILTER_PAIRS (${MAX_JSON_FILTER_PAIRS})`, () => {
      const parts: string[] = []
      for (let i = 0; i < MAX_JSON_FILTER_PAIRS + 5; i++) {
        parts.push(`data.k${i}=${i}`)
      }
      const params = new URLSearchParams(parts.join('&'))
      expect(parseJsonFilterPairs(params, 'data')).toHaveLength(MAX_JSON_FILTER_PAIRS)
    })
  })

  describe('search param pairs', () => {
    it('parses repeated delimited params', () => {
      const params = new URLSearchParams('col=id%7CID&col=data.tenantId%7CTenant&state=failed')

      expect(parseSearchParamPairs(params, 'col')).toEqual([
        { key: 'id', value: 'ID' },
        { key: 'data.tenantId', value: 'Tenant' },
      ])
    })

    it('supports missing values and custom separators', () => {
      const params = new URLSearchParams('item=name:item-name&item=state')

      expect(parseSearchParamPairs(params, 'item', ':')).toEqual([
        { key: 'name', value: 'item-name' },
        { key: 'state', value: '' },
      ])
    })

    it('appends repeated delimited params', () => {
      const params = new URLSearchParams('state=failed')

      appendSearchParamPairs(params, 'col', [
        { key: 'id', value: 'ID' },
        { key: 'data.tenantId', value: 'Tenant' },
      ])

      expect(params.get('state')).toBe('failed')
      expect(params.getAll('col')).toEqual(['id|ID', 'data.tenantId|Tenant'])
    })
  })

  describe('jsonFilterPairsToObject', () => {
    it('returns an empty object for no pairs', () => {
      expect(jsonFilterPairsToObject([])).toEqual({})
    })

    it('coerces numeric strings to numbers', () => {
      expect(jsonFilterPairsToObject([{ key: 'value', value: '1234' }]))
        .toEqual({ value: 1234 })
      expect(jsonFilterPairsToObject([{ key: 'temp', value: '-3.5' }]))
        .toEqual({ temp: -3.5 })
    })

    it('coerces boolean strings to booleans', () => {
      expect(jsonFilterPairsToObject([{ key: 'enabled', value: 'true' }]))
        .toEqual({ enabled: true })
      expect(jsonFilterPairsToObject([{ key: 'enabled', value: 'false' }]))
        .toEqual({ enabled: false })
    })

    it('keeps non-numeric strings as strings', () => {
      expect(jsonFilterPairsToObject([
        { key: 'sessionId', value: '6dff4e1b-9c74-4d53-9969-1991d887e7ca' },
      ])).toEqual({
        sessionId: '6dff4e1b-9c74-4d53-9969-1991d887e7ca',
      })
    })

    it('skips pairs with empty keys', () => {
      expect(jsonFilterPairsToObject([
        { key: '', value: 'x' },
        { key: 'k', value: 'y' },
      ])).toEqual({ k: 'y' })
    })
  })
})
