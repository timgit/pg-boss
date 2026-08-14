import { describe, it, expect } from 'vitest'
import { cronHuman } from '~/routes/schedules'

describe('cronHuman', () => {
  it('describes daily times only when day fields are wildcards', () => {
    expect(cronHuman('0 2 * * *')).toBe('Every day at 02:00')
    expect(cronHuman('30 4 * * *')).toBe('Every day at 04:30')
    expect(cronHuman('0 0 * * *')).toBe('Every day at midnight')
  })

  it('does not claim daily for a weekly schedule', () => {
    expect(cronHuman('0 4 * * 0')).toBe('Weekly on Sunday at 04:00')
    expect(cronHuman('30 9 * * 1')).toBe('Weekly on Monday at 09:30')
    expect(cronHuman('0 4 * * 7')).toBe('Weekly on Sunday at 04:00')
  })

  it('describes minute intervals only when all other fields are wildcards', () => {
    expect(cronHuman('*/15 * * * *')).toBe('Every 15 minutes')
    expect(cronHuman('*/15 * * * 1')).toBe('Custom schedule')
    expect(cronHuman('*/15 2 * * *')).toBe('Custom schedule')
  })

  it('describes hourly and monthly patterns', () => {
    expect(cronHuman('0 * * * *')).toBe('Every hour on the hour')
    expect(cronHuman('0 0 1 * *')).toBe('Monthly on the 1st at 00:00')
    expect(cronHuman('0 12 22 * *')).toBe('Monthly on the 22nd at 12:00')
    expect(cronHuman('0 12 11 * *')).toBe('Monthly on the 11th at 12:00')
  })

  it('falls back to Custom schedule for anything bespoke', () => {
    expect(cronHuman('0 4 1 1 *')).toBe('Custom schedule')
    expect(cronHuman('0 4 * * 1-5')).toBe('Custom schedule')
    expect(cronHuman('not a cron')).toBe('Custom schedule')
    expect(cronHuman('0 4 * *')).toBe('Custom schedule')
  })
})
