import { describe, it, expect } from 'vitest'
import { getConfig } from '../../../../src/attorney.ts'
import { OPTION_DEFAULTS, isChangedOption } from '~/lib/instances'

// The dashboard highlights the options an instance changed by comparing them with these. Core
// resolves most of them in `getConfig`; a few it applies where they are used, and those are listed
// here by name so a change to how core resolves them is noticed.
const APPLIED_ELSEWHERE = ['adapter', 'max', 'monitorVacuum', 'persistWarnings', 'persistQueueStats', 'warningSlowQuerySeconds', 'warningQueueSize']

describe('OPTION_DEFAULTS', () => {
  const resolved = getConfig({ connectionString: 'postgres://localhost/defaults' }) as unknown as Record<string, unknown>

  it('matches what core resolves each option to when it is not given', () => {
    for (const [key, value] of Object.entries(OPTION_DEFAULTS)) {
      if (APPLIED_ELSEWHERE.includes(key)) {
        expect(resolved[key], key).toBeUndefined()
      } else {
        expect(resolved[key], key).toEqual(value)
      }
    }
  })

  it('tells a changed option from a default one, and leaves unknown keys alone', () => {
    expect(isChangedOption('monitorIntervalSeconds', 60)).toBe(false)
    expect(isChangedOption('monitorIntervalSeconds', 30)).toBe(true)
    expect(isChangedOption('reindex', { minPages: 100 })).toBe(true)
    expect(isChangedOption('startAttempt', 3)).toBe(false)
  })
})
