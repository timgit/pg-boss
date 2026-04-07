/**
 * Compile-time drift detection between Zod schemas and HTTP types.
 *
 * z.ZodType<T> only checks that the schema output is assignable to T,
 * which misses new optional fields added upstream. These assertions
 * check key equality in both directions so drift is caught at build time.
 *
 * Run: npx vitest run --typecheck test/typeDriftTest.ts
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type * as contracts from '../src/contracts.js'
import type * as httpTypes from '../src/types.js'

type SchemaOutput<T extends z.ZodTypeAny> = z.output<T>

type AssertKeysMatch<A, B> =
  [Exclude<keyof A, keyof B>] extends [never]
    ? [Exclude<keyof B, keyof A>] extends [never]
        ? true
        : { error: 'Keys missing from Zod schema'; keys: Exclude<keyof B, keyof A> }
    : { error: 'Extra keys in Zod schema'; keys: Exclude<keyof A, keyof B> }

function assertKeysMatch<T extends true> (): T { return true as T }

describe('Zod schema / HTTP type key drift', () => {
  it('groupOptionsSchema matches HttpGroupOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.groupOptionsSchema>, httpTypes.HttpGroupOptions>>()).toBe(true)
  })

  it('groupConcurrencyConfigSchema matches HttpGroupConcurrencyConfig', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.groupConcurrencyConfigSchema>, httpTypes.HttpGroupConcurrencyConfig>>()).toBe(true)
  })

  it('sendOptionsSchema matches HttpSendOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.sendOptionsSchema>, httpTypes.HttpSendOptions>>()).toBe(true)
  })

  it('queueOptionsSchema matches HttpQueueOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.queueOptionsSchema>, httpTypes.HttpQueueOptions>>()).toBe(true)
  })

  it('scheduleOptionsSchema matches HttpScheduleOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.scheduleOptionsSchema>, httpTypes.HttpScheduleOptions>>()).toBe(true)
  })

  it('fetchOptionsSchema matches HttpFetchOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.fetchOptionsSchema>, httpTypes.HttpFetchOptions>>()).toBe(true)
  })

  it('findJobsOptionsSchema matches HttpFindJobsOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.findJobsOptionsSchema>, httpTypes.HttpFindJobsOptions>>()).toBe(true)
  })

  it('insertOptionsSchema matches HttpInsertOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.insertOptionsSchema>, httpTypes.HttpInsertOptions>>()).toBe(true)
  })

  it('completeOptionsSchema matches HttpCompleteOptions', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.completeOptionsSchema>, httpTypes.HttpCompleteOptions>>()).toBe(true)
  })

  it('jobInsertSchema matches HttpJobInsert', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.jobInsertSchema>, httpTypes.HttpJobInsert>>()).toBe(true)
  })

  it('jobSchema matches HttpJob', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.jobSchema>, httpTypes.HttpJob>>()).toBe(true)
  })

  it('jobWithMetadataSchema matches HttpJobWithMetadata', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.jobWithMetadataSchema>, httpTypes.HttpJobWithMetadata>>()).toBe(true)
  })

  it('commandResponseSchema matches HttpCommandResponse', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.commandResponseSchema>, httpTypes.HttpCommandResponse>>()).toBe(true)
  })

  it('queueResultSchema matches HttpQueueResult', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.queueResultSchema>, httpTypes.HttpQueueResult>>()).toBe(true)
  })

  it('scheduleSchema matches HttpSchedule', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.scheduleSchema>, httpTypes.HttpSchedule>>()).toBe(true)
  })

  it('bamStatusSummarySchema matches HttpBamStatusSummary', () => {
    expect(assertKeysMatch<AssertKeysMatch<SchemaOutput<typeof contracts.bamStatusSummarySchema>, httpTypes.HttpBamStatusSummary>>()).toBe(true)
  })
})
