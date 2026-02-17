import type * as types from './types.js'
import { z } from 'zod'

// ============== Base Types ==============
export const jsonRecordSchema: z.ZodType<types.HttpJsonRecord> = z.record(z.string(), z.unknown())

export const nullableJsonRecordSchema: z.ZodType<types.HttpNullableJsonRecord> = jsonRecordSchema.nullable()

export const dateInputSchema: z.ZodType<types.HttpDateInput> = z.union([z.string(), z.number()])

export const queueNameSchema: z.ZodType<types.HttpQueueName> = z.string().min(1)

export const eventNameSchema: z.ZodType<types.HttpEventName> = z.string().min(1)

export const errorResultSchema: z.ZodType<types.HttpErrorResult> = z.object({
  ok: z.literal(false),
  error: z.object({
    message: z.string()
  })
})

export const htmlResponseSchema: z.ZodType<types.HttpHtmlResponse> = z.string()

// ============== pg-boss Types ==============

export const groupOptionsSchema: z.ZodType<types.HttpGroupOptions> = z.object({
  id: z.string(),
  tier: z.string().optional()
})

export const groupConcurrencyConfigSchema: z.ZodType<types.HttpGroupConcurrencyConfig> = z.object({
  default: z.number(),
  tiers: z.record(z.string(), z.number()).optional()
})

const sendOptionsSchemaBase = z.object({
  id: z.string().optional(),
  priority: z.number().optional(),
  startAfter: dateInputSchema.optional(),
  singletonKey: z.string().optional(),
  singletonSeconds: z.number().optional(),
  singletonNextSlot: z.boolean().optional(),
  keepUntil: dateInputSchema.optional(),
  group: groupOptionsSchema.optional(),
  deadLetter: z.string().optional(),
  expireInSeconds: z.number().optional(),
  retentionSeconds: z.number().optional(),
  deleteAfterSeconds: z.number().optional(),
  retryLimit: z.number().optional(),
  retryDelay: z.number().optional(),
  retryBackoff: z.boolean().optional(),
  retryDelayMax: z.number().optional(),
  heartbeatSeconds: z.number().optional(),
})

export const sendOptionsSchema: z.ZodType<types.HttpSendOptions> = sendOptionsSchemaBase

export const queueOptionsSchema: z.ZodType<types.HttpQueueOptions> = z.object({
  expireInSeconds: z.number().optional(),
  retentionSeconds: z.number().optional(),
  deleteAfterSeconds: z.number().optional(),
  retryLimit: z.number().optional(),
  retryDelay: z.number().optional(),
  retryBackoff: z.boolean().optional(),
  retryDelayMax: z.number().optional(),
  heartbeatSeconds: z.number().optional(),
})

export const scheduleOptionsSchema: z.ZodType<types.HttpScheduleOptions> = sendOptionsSchemaBase.extend({
  tz: z.string().optional(),
  key: z.string().optional(),
})

export const fetchOptionsSchema: z.ZodType<types.HttpFetchOptions> = z.object({
  includeMetadata: z.boolean().optional(),
  priority: z.boolean().optional(),
  orderByCreatedOn: z.boolean().optional(),
  batchSize: z.number().optional(),
  ignoreStartAfter: z.boolean().optional(),
  groupConcurrency: z.union([z.number(), groupConcurrencyConfigSchema]).optional(),
  ignoreGroups: z.array(z.string()).nullable().optional(),
})

export const findJobsOptionsSchema: z.ZodType<types.HttpFindJobsOptions> = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  data: jsonRecordSchema.optional(),
  queued: z.boolean().optional(),
})

export const insertOptionsSchema: z.ZodType<types.HttpInsertOptions> = z.object({
  returnId: z.boolean().optional(),
})

export const completeOptionsSchema: z.ZodType<types.HttpCompleteOptions> = z.object({
  includeQueued: z.boolean().optional(),
})

export const jobInsertSchema: z.ZodType<types.HttpJobInsert> = z.object({
  id: z.string().optional(),
  data: jsonRecordSchema.optional(),
  priority: z.number().optional(),
  retryLimit: z.number().optional(),
  retryDelay: z.number().optional(),
  retryBackoff: z.boolean().optional(),
  retryDelayMax: z.number().optional(),
  startAfter: dateInputSchema.optional(),
  singletonKey: z.string().optional(),
  singletonSeconds: z.number().optional(),
  expireInSeconds: z.number().optional(),
  deleteAfterSeconds: z.number().optional(),
  retentionSeconds: z.number().optional(),
  heartbeatSeconds: z.number().optional(),
  group: groupOptionsSchema.optional(),
  deadLetter: z.string().optional(),
})

const jobSchemaBase = z.object({
  id: z.string(),
  name: z.string(),
  data: jsonRecordSchema,
  expireInSeconds: z.number(),
  heartbeatSeconds: z.number().nullable(),
  groupId: z.string().optional().nullable(),
  groupTier: z.string().optional().nullable(),
})

export const jobSchema: z.ZodType<types.HttpJob> = jobSchemaBase

export const jobWithMetadataSchema: z.ZodType<types.HttpJobWithMetadata> = jobSchemaBase.extend({
  priority: z.number(),
  state: z.enum(['created', 'retry', 'active', 'completed', 'cancelled', 'failed']),
  retryLimit: z.number(),
  retryCount: z.number(),
  retryDelay: z.number(),
  retryBackoff: z.boolean(),
  retryDelayMax: z.number().optional(),
  startAfter: z.iso.datetime().transform((val) => new Date(val)),
  startedOn: z.iso.datetime().transform((val) => new Date(val)),
  singletonKey: z.string().nullable(),
  singletonOn: z.string().nullable(),
  deleteAfterSeconds: z.number(),
  createdOn: z.iso.datetime().transform((val) => new Date(val)),
  completedOn: z.iso.datetime().nullable().transform((val) => val ? new Date(val) : null),
  keepUntil: z.iso.datetime().transform((val) => new Date(val)),
  policy: z.string(),
  deadLetter: z.string(),
  output: jsonRecordSchema,
})

export const commandResponseSchema: z.ZodType<types.HttpCommandResponse> = z.object({
  jobs: z.array(z.string()),
  requested: z.number(),
  affected: z.number(),
})

export const queueResultSchema: z.ZodType<types.HttpQueueResult> = z.object({
  name: z.string(),
  expireInSeconds: z.number().optional(),
  retentionSeconds: z.number().optional(),
  deleteAfterSeconds: z.number().optional(),
  retryLimit: z.number().optional(),
  retryDelay: z.number().optional(),
  retryBackoff: z.boolean().optional(),
  retryDelayMax: z.number().optional(),
  policy: z.string().optional(),
  partition: z.boolean().optional(),
  deadLetter: z.string().optional(),
  warningQueueSize: z.number().optional(),
  heartbeatSeconds: z.number().optional(),
  deferredCount: z.number(),
  queuedCount: z.number(),
  activeCount: z.number(),
  totalCount: z.number(),
  table: z.string(),
  createdOn: z.iso.datetime().transform((val) => new Date(val)),
  updatedOn: z.iso.datetime().transform((val) => new Date(val)),
  singletonsActive: z.array(z.string()).nullable(),
})

export const scheduleSchema: z.ZodType<types.HttpSchedule> = z.object({
  name: z.string(),
  key: z.string(),
  cron: z.string(),
  timezone: z.string(),
  data: jsonRecordSchema.optional(),
  options: sendOptionsSchema.optional(),
})

export const bamStatusSummarySchema: z.ZodType<types.HttpBamStatusSummary> = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  count: z.number(),
  lastCreatedOn: z.iso.datetime().transform((val) => new Date(val)),
})

// ============== Request/Response Types ==============

export const metaResultSchema: z.ZodType<types.HttpMetaResult> = z.object({
  states: z.record(z.string(), z.string()),
  policies: z.record(z.string(), z.string()),
  events: z.record(z.string(), z.string())
})

export const metaResponseSchema: z.ZodType<types.HttpMetaResponse> = z.object({
  ok: z.literal(true),
  result: metaResultSchema
})

export const sendRequestSchema: z.ZodType<types.HttpSendRequest> = z.object({
  name: queueNameSchema,
  data: nullableJsonRecordSchema.optional(),
  options: sendOptionsSchema.optional()
})

export const sendResponseSchema: z.ZodType<types.HttpSendResponse> = z.object({
  ok: z.literal(true),
  result: z.string().nullable()
})

export const sendAfterRequestSchema: z.ZodType<types.HttpSendAfterRequest> = z.object({
  name: queueNameSchema,
  data: nullableJsonRecordSchema.optional(),
  options: sendOptionsSchema.optional().nullable(),
  after: dateInputSchema
})

export const sendAfterResponseSchema: z.ZodType<types.HttpSendAfterResponse> = z.object({
  ok: z.literal(true),
  result: z.string().nullable()
})

export const sendThrottledRequestSchema: z.ZodType<types.HttpSendThrottledRequest> = z.object({
  name: queueNameSchema,
  data: nullableJsonRecordSchema.optional(),
  options: sendOptionsSchema.optional().nullable(),
  seconds: z.number(),
  key: z.string().optional()
})

export const sendThrottledResponseSchema: z.ZodType<types.HttpSendThrottledResponse> = z.object({
  ok: z.literal(true),
  result: z.string().nullable()
})

export const sendDebouncedRequestSchema: z.ZodType<types.HttpSendDebouncedRequest> = z.object({
  name: queueNameSchema,
  data: nullableJsonRecordSchema.optional(),
  options: sendOptionsSchema.optional().nullable(),
  seconds: z.number(),
  key: z.string().optional()
})

export const sendDebouncedResponseSchema: z.ZodType<types.HttpSendDebouncedResponse> = z.object({
  ok: z.literal(true),
  result: z.string().nullable()
})

export const insertRequestSchema: z.ZodType<types.HttpInsertRequest> = z.object({
  name: queueNameSchema,
  jobs: z.array(jobInsertSchema),
  options: insertOptionsSchema.optional()
})

export const insertResponseSchema: z.ZodType<types.HttpInsertResponse> = z.object({
  ok: z.literal(true),
  result: z.array(z.string()).nullable()
})

export const fetchRequestSchema: z.ZodType<types.HttpFetchRequest> = z.object({
  name: queueNameSchema,
  options: fetchOptionsSchema.optional()
})

export const fetchResponseSchema: z.ZodType<types.HttpFetchResponse> = z.object({
  ok: z.literal(true),
  result: z.union([z.array(jobWithMetadataSchema), z.array(jobSchema)])
})

export const subscribeRequestSchema: z.ZodType<types.HttpSubscribeRequest> = z.object({
  event: eventNameSchema,
  name: queueNameSchema
})

export const subscribeResponseSchema: z.ZodType<types.HttpSubscribeResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const unsubscribeRequestSchema: z.ZodType<types.HttpUnsubscribeRequest> = z.object({
  event: eventNameSchema,
  name: queueNameSchema
})

export const unsubscribeResponseSchema: z.ZodType<types.HttpUnsubscribeResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const publishRequestSchema: z.ZodType<types.HttpPublishRequest> = z.object({
  event: eventNameSchema,
  data: nullableJsonRecordSchema.optional(),
  options: sendOptionsSchema.optional()
})

export const publishResponseSchema: z.ZodType<types.HttpPublishResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const cancelRequestSchema: z.ZodType<types.HttpCancelRequest> = z.object({
  name: queueNameSchema,
  id: z.union([z.string(), z.array(z.string())])
})

export const cancelResponseSchema: z.ZodType<types.HttpCancelResponse> = z.object({
  ok: z.literal(true),
  result: commandResponseSchema
})

export const resumeRequestSchema: z.ZodType<types.HttpResumeRequest> = z.object({
  name: queueNameSchema,
  id: z.union([z.string(), z.array(z.string())])
})

export const resumeResponseSchema: z.ZodType<types.HttpResumeResponse> = z.object({
  ok: z.literal(true),
  result: commandResponseSchema
})

export const retryRequestSchema: z.ZodType<types.HttpRetryRequest> = z.object({
  name: queueNameSchema,
  id: z.union([z.string(), z.array(z.string())])
})

export const retryResponseSchema: z.ZodType<types.HttpRetryResponse> = z.object({
  ok: z.literal(true),
  result: commandResponseSchema
})

export const deleteJobRequestSchema: z.ZodType<types.HttpDeleteJobRequest> = z.object({
  name: queueNameSchema,
  id: z.union([z.string(), z.array(z.string())])
})

export const deleteJobResponseSchema: z.ZodType<types.HttpDeleteJobResponse> = z.object({
  ok: z.literal(true),
  result: commandResponseSchema
})

export const deleteQueuedJobsRequestSchema: z.ZodType<types.HttpDeleteQueuedJobsRequest> = z.object({
  name: queueNameSchema
})

export const deleteQueuedJobsResponseSchema: z.ZodType<types.HttpDeleteQueuedJobsResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const deleteStoredJobsRequestSchema: z.ZodType<types.HttpDeleteStoredJobsRequest> = z.object({
  name: queueNameSchema
})

export const deleteStoredJobsResponseSchema: z.ZodType<types.HttpDeleteStoredJobsResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const deleteAllJobsRequestSchema: z.ZodType<types.HttpDeleteAllJobsRequest> = z.object({
  name: queueNameSchema.optional()
})

export const deleteAllJobsResponseSchema: z.ZodType<types.HttpDeleteAllJobsResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const completeRequestSchema: z.ZodType<types.HttpCompleteRequest> = z.object({
  name: queueNameSchema,
  id: z.union([z.string(), z.array(z.string())]),
  data: nullableJsonRecordSchema.optional(),
  options: completeOptionsSchema.optional()
})

export const completeResponseSchema: z.ZodType<types.HttpCompleteResponse> = z.object({
  ok: z.literal(true),
  result: commandResponseSchema
})

export const failRequestSchema: z.ZodType<types.HttpFailRequest> = z.object({
  name: queueNameSchema,
  id: z.union([z.string(), z.array(z.string())]),
  data: nullableJsonRecordSchema.optional()
})

export const failResponseSchema: z.ZodType<types.HttpFailResponse> = z.object({
  ok: z.literal(true),
  result: commandResponseSchema
})

export const findJobsResponseSchema: z.ZodType<types.HttpFindJobsResponse> = z.object({
  ok: z.literal(true),
  result: z.array(jobWithMetadataSchema)
})

export const createQueueRequestSchema: z.ZodType<types.HttpCreateQueueRequest> = z.object({
  name: queueNameSchema,
  options: queueOptionsSchema.and(z.object({
    policy: z.string().optional(),
    partition: z.boolean().optional(),
    deadLetter: z.string().optional(),
    warningQueueSize: z.number().optional()
  })).optional()
})

export const createQueueResponseSchema: z.ZodType<types.HttpCreateQueueResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const getBlockedKeysResponseSchema: z.ZodType<types.HttpGetBlockedKeysResponse> = z.object({
  ok: z.literal(true),
  result: z.array(z.string())
})

export const updateQueueRequestSchema: z.ZodType<types.HttpUpdateQueueRequest> = z.object({
  name: queueNameSchema,
  options: queueOptionsSchema.and(z.object({
    deadLetter: z.string().optional(),
    warningQueueSize: z.number().optional()
  })).optional()
})

export const updateQueueResponseSchema: z.ZodType<types.HttpUpdateQueueResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const deleteQueueRequestSchema: z.ZodType<types.HttpDeleteQueueRequest> = z.object({
  name: queueNameSchema
})

export const deleteQueueResponseSchema: z.ZodType<types.HttpDeleteQueueResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const getQueuesResponseSchema: z.ZodType<types.HttpGetQueuesResponse> = z.object({
  ok: z.literal(true),
  result: z.array(queueResultSchema)
})

export const getQueueResponseSchema: z.ZodType<types.HttpGetQueueResponse> = z.object({
  ok: z.literal(true),
  result: queueResultSchema.nullable()
})

export const getQueueStatsResponseSchema: z.ZodType<types.HttpGetQueueStatsResponse> = z.object({
  ok: z.literal(true),
  result: queueResultSchema
})

export const superviseRequestSchema: z.ZodType<types.HttpSuperviseRequest> = z.object({
  name: queueNameSchema.optional()
})

export const superviseResponseSchema: z.ZodType<types.HttpSuperviseResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const isInstalledResponseSchema: z.ZodType<types.HttpIsInstalledResponse> = z.object({
  ok: z.literal(true),
  result: z.boolean()
})

export const schemaVersionResponseSchema: z.ZodType<types.HttpSchemaVersionResponse> = z.object({
  ok: z.literal(true),
  result: z.number().nullable()
})

export const scheduleRequestSchema: z.ZodType<types.HttpScheduleRequest> = z.object({
  name: queueNameSchema,
  cron: z.string(),
  data: nullableJsonRecordSchema.optional(),
  options: scheduleOptionsSchema.optional()
})

export const scheduleResponseSchema: z.ZodType<types.HttpScheduleResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const unscheduleRequestSchema: z.ZodType<types.HttpUnscheduleRequest> = z.object({
  name: queueNameSchema,
  key: z.string().optional()
})

export const unscheduleResponseSchema: z.ZodType<types.HttpUnscheduleResponse> = z.object({
  ok: z.literal(true),
  result: z.null()
})

export const getSchedulesResponseSchema: z.ZodType<types.HttpGetSchedulesResponse> = z.object({
  ok: z.literal(true),
  result: z.array(scheduleSchema)
})

export const getBamStatusResponseSchema: z.ZodType<types.HttpGetBamStatusResponse> = z.object({
  ok: z.literal(true),
  result: z.array(bamStatusSummarySchema)
})
