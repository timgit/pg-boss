/**
 * Compile-time drift detection between Zod schemas and HTTP types.
 *
 * z.ZodType<T> only checks that the schema output is assignable to T,
 * which misses new optional fields added upstream. These assertions
 * check key equality in both directions so drift is caught at build time.
 */
import type { z } from 'zod'
import type * as contracts from './contracts.js'
import type * as httpTypes from './types.js'

/** Fails to compile when A and B don't have exactly the same keys. */
type AssertKeysMatch<A, B> =
  [Exclude<keyof A, keyof B>] extends [never]
    ? [Exclude<keyof B, keyof A>] extends [never]
      ? true
      : never
    : never

type SchemaOutput<T extends z.ZodTypeAny> = z.output<T>

// pg-boss–derived schemas
const _groupOptions: AssertKeysMatch<SchemaOutput<typeof contracts.groupOptionsSchema>, httpTypes.HttpGroupOptions> = true
const _groupConcurrencyConfig: AssertKeysMatch<SchemaOutput<typeof contracts.groupConcurrencyConfigSchema>, httpTypes.HttpGroupConcurrencyConfig> = true
const _sendOptions: AssertKeysMatch<SchemaOutput<typeof contracts.sendOptionsSchema>, httpTypes.HttpSendOptions> = true
const _queueOptions: AssertKeysMatch<SchemaOutput<typeof contracts.queueOptionsSchema>, httpTypes.HttpQueueOptions> = true
const _scheduleOptions: AssertKeysMatch<SchemaOutput<typeof contracts.scheduleOptionsSchema>, httpTypes.HttpScheduleOptions> = true
const _fetchOptions: AssertKeysMatch<SchemaOutput<typeof contracts.fetchOptionsSchema>, httpTypes.HttpFetchOptions> = true
const _findJobsOptions: AssertKeysMatch<SchemaOutput<typeof contracts.findJobsOptionsSchema>, httpTypes.HttpFindJobsOptions> = true
const _insertOptions: AssertKeysMatch<SchemaOutput<typeof contracts.insertOptionsSchema>, httpTypes.HttpInsertOptions> = true
const _completeOptions: AssertKeysMatch<SchemaOutput<typeof contracts.completeOptionsSchema>, httpTypes.HttpCompleteOptions> = true
const _jobInsert: AssertKeysMatch<SchemaOutput<typeof contracts.jobInsertSchema>, httpTypes.HttpJobInsert> = true
const _job: AssertKeysMatch<SchemaOutput<typeof contracts.jobSchema>, httpTypes.HttpJob> = true
const _jobWithMetadata: AssertKeysMatch<SchemaOutput<typeof contracts.jobWithMetadataSchema>, httpTypes.HttpJobWithMetadata> = true
const _commandResponse: AssertKeysMatch<SchemaOutput<typeof contracts.commandResponseSchema>, httpTypes.HttpCommandResponse> = true
const _queueResult: AssertKeysMatch<SchemaOutput<typeof contracts.queueResultSchema>, httpTypes.HttpQueueResult> = true
const _schedule: AssertKeysMatch<SchemaOutput<typeof contracts.scheduleSchema>, httpTypes.HttpSchedule> = true
const _bamStatusSummary: AssertKeysMatch<SchemaOutput<typeof contracts.bamStatusSummarySchema>, httpTypes.HttpBamStatusSummary> = true

// Suppress unused variable warnings
void _groupOptions, _groupConcurrencyConfig, _sendOptions, _queueOptions, _scheduleOptions
void _fetchOptions, _findJobsOptions, _insertOptions, _completeOptions, _jobInsert
void _job, _jobWithMetadata, _commandResponse, _queueResult, _schedule, _bamStatusSummary
