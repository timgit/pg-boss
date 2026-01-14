import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parsePageNumber,
  formatTimeAgo,
  formatDate,
  formatDateWithSeconds,
  formatWarningData,
  isValidJobState,
  isValidWarningType,
  JOB_STATES,
  WARNING_TYPES,
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
})
