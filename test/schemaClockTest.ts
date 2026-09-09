import { describe, it } from 'vitest'
import { expect } from './hooks.ts'
import * as plans from '../src/plans.ts'

// A clock read that is not qualified with the schema. `.now(` (Date.now, s.now) is excluded.
const BARE_NOW = /(^|[^.\w])now\s*\(/

describe('schema clock', function () {
  it('every runtime statement reads the clock through the schema function', function () {
    const schema = 's'
    const samples: Record<string, string> = {
      getTime: plans.getTime(schema),
      insertJobs: plans.insertJobs(schema, { table: 'job', name: 'q' }),
      fetchNextJob: plans.fetchNextJob({ schema, table: 'job', name: 'q', policy: 'standard', limit: 1, includeMetadata: false } as any).text,
      failJobsByTimeout: plans.failJobsByTimeout(schema, 'job', ['q']),
      failJobsByHeartbeat: plans.failJobsByHeartbeat(schema, 'job', ['q']),
      deletion: plans.deletion(schema, 'job', ['q']),
      retryJobs: plans.retryJobs(schema, 'job'),
      trySetCronTime: plans.trySetCronTime(schema, 60),
      schedule: plans.schedule(schema),
      deleteOldWarnings: plans.deleteOldWarnings(schema, 7)
    }

    // retryJobs flips a failed job back to retry and clears completed_on without writing any
    // timestamp, so it has no clock read to qualify; every other sample must have one.
    const NO_CLOCK_READ = new Set(['retryJobs'])

    for (const [name, sql] of Object.entries(samples)) {
      expect(sql).not.toMatch(BARE_NOW)
      if (!NO_CLOCK_READ.has(name)) {
        expect(sql).toContain(`${schema}.now()`)
      }
    }
  })
})
