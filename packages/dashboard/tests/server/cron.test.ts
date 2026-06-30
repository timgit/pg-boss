import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextCronOccurrence } from '~/lib/cron.server'

describe('nextCronOccurrence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes the next fire time in UTC by default', () => {
    // Daily at 02:00 — from 12:00 on the 15th, the next fire is 02:00 on the 16th.
    const next = nextCronOccurrence('0 2 * * *')
    expect(next?.toISOString()).toBe('2024-01-16T02:00:00.000Z')
  })

  it('honors the schedule timezone', () => {
    // 02:00 in New York (UTC-5 in January) is 07:00 UTC.
    const next = nextCronOccurrence('0 2 * * *', 'America/New_York')
    expect(next?.toISOString()).toBe('2024-01-16T07:00:00.000Z')
  })

  it('treats an empty timezone as UTC', () => {
    const next = nextCronOccurrence('0 2 * * *', '')
    expect(next?.toISOString()).toBe('2024-01-16T02:00:00.000Z')
  })

  it('returns a future date for a frequent schedule', () => {
    const next = nextCronOccurrence('*/15 * * * *')
    expect(next?.toISOString()).toBe('2024-01-15T12:15:00.000Z')
  })

  it('returns null for an unparseable cron', () => {
    expect(nextCronOccurrence('not a cron')).toBeNull()
    expect(nextCronOccurrence('99 99 99 99 99')).toBeNull()
  })
})
