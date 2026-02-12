export type JsonRecord = Record<string, unknown>
export type NullableJsonRecord = JsonRecord | null
export type DateInput = string | number

/**
 * @minLength 1
 */
export type QueueName = string

/**
 * @minLength 1
 */
export type EventName = string

export type ErrorResult = {
  ok: false
  error: { message: string }
}

export type HtmlResponse = string

export type GroupOptions = {
  id: string
  tier?: string
}

export type GroupConcurrencyConfig = {
  default: number
  tiers?: Record<string, number>
}

export type QueueOptions = {
  expireInSeconds?: number
  retentionSeconds?: number
  deleteAfterSeconds?: number
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  retryDelayMax?: number
}

export type JobOptions = {
  id?: string
  priority?: number
  startAfter?: DateInput
  singletonKey?: string
  singletonSeconds?: number
  singletonNextSlot?: boolean
  keepUntil?: DateInput
  group?: GroupOptions
  deadLetter?: string
}

export type SendOptions = JobOptions & QueueOptions

export type ScheduleOptions = SendOptions & {
  tz?: string
  key?: string
}

export type FetchOptions = {
  includeMetadata?: boolean
  priority?: boolean
  orderByCreatedOn?: boolean
  batchSize?: number
  ignoreStartAfter?: boolean
  groupConcurrency?: number | GroupConcurrencyConfig
  ignoreGroups?: string[] | null
}

export type FindJobsOptions = {
  id?: string
  key?: string
  data?: JsonRecord
  queued?: boolean
}

export type InsertOptions = {
  returnId?: boolean
}

export type UpdateQueueOptions = QueueOptions & {
  deadLetter?: string
  warningQueueSize?: number
}

export type QueueResult = QueueOptions & {
  name: string
  policy?: string
  partition?: boolean
  deadLetter?: string
  warningQueueSize?: number
  deferredCount: number
  queuedCount: number
  activeCount: number
  totalCount: number
  table: string
  createdOn: string
  updatedOn: string
  singletonsActive: string[] | null
}

export type Job = {
  id: string
  name: string
  data: JsonRecord
  expireInSeconds: number
  signal: unknown
  groupId?: string | null
  groupTier?: string | null
}

export type JobWithMetadata = Job & {
  priority: number
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'
  retryLimit: number
  retryCount: number
  retryDelay: number
  retryBackoff: boolean
  retryDelayMax?: number
  startAfter: string
  startedOn: string
  singletonKey: string | null
  singletonOn: string | null
  deleteAfterSeconds: number
  createdOn: string
  completedOn: string | null
  keepUntil: string
  policy: string
  deadLetter: string
  output: JsonRecord
}

export type CommandResponse = {
  jobs: string[]
  requested: number
  affected: number
}

export type Schedule = {
  name: string
  key: string
  cron: string
  timezone: string
  data?: JsonRecord
  options?: SendOptions
}

export type BamStatusSummary = {
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  count: number
  lastCreatedOn: string
}

export type MetaResult = {
  states: Record<string, string>
  policies: Record<string, string>
  events: Record<string, string>
}

export type MetaResponse = {
  ok: true
  result: MetaResult
}

export type SendRequest = {
  name: QueueName
  data?: NullableJsonRecord
  options?: SendOptions
}

export type SendResponse = {
  ok: true
  result: string | null
}

export type SendAfterRequest = {
  name: QueueName
  data?: NullableJsonRecord
  options?: SendOptions | null
  after: DateInput
}

export type SendAfterResponse = {
  ok: true
  result: string | null
}

export type SendThrottledRequest = {
  name: QueueName
  data?: NullableJsonRecord
  options?: SendOptions | null
  seconds: number
  key?: string
}

export type SendThrottledResponse = {
  ok: true
  result: string | null
}

export type SendDebouncedRequest = {
  name: QueueName
  data?: NullableJsonRecord
  options?: SendOptions | null
  seconds: number
  key?: string
}

export type SendDebouncedResponse = {
  ok: true
  result: string | null
}

export type InsertRequest = {
  name: QueueName
  jobs: JobInsert[]
  options?: InsertOptions
}

export type InsertResponse = {
  ok: true
  result: string[] | null
}

export type JobInsert = {
  id?: string
  data?: JsonRecord
  priority?: number
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  retryDelayMax?: number
  startAfter?: DateInput
  singletonKey?: string
  singletonSeconds?: number
  expireInSeconds?: number
  deleteAfterSeconds?: number
  retentionSeconds?: number
  group?: GroupOptions
  deadLetter?: string
}

export type FetchRequest = {
  name: QueueName
  options?: FetchOptions
}

export type FetchResponse = {
  ok: true
  result: JobWithMetadata[] | Job[]
}

export type SubscribeRequest = {
  event: EventName
  name: QueueName
}

export type SubscribeResponse = {
  ok: true
  result: null
}

export type UnsubscribeRequest = {
  event: EventName
  name: QueueName
}

export type UnsubscribeResponse = {
  ok: true
  result: null
}

export type PublishRequest = {
  event: EventName
  data?: NullableJsonRecord
  options?: SendOptions
}

export type PublishResponse = {
  ok: true
  result: null
}

export type CancelRequest = {
  name: QueueName
  id: string | string[]
}

export type CancelResponse = {
  ok: true
  result: CommandResponse
}

export type ResumeRequest = {
  name: QueueName
  id: string | string[]
}

export type ResumeResponse = {
  ok: true
  result: CommandResponse
}

export type RetryRequest = {
  name: QueueName
  id: string | string[]
}

export type RetryResponse = {
  ok: true
  result: CommandResponse
}

export type DeleteJobRequest = {
  name: QueueName
  id: string | string[]
}

export type DeleteJobResponse = {
  ok: true
  result: CommandResponse
}

export type DeleteQueuedJobsRequest = {
  name: QueueName
}

export type DeleteQueuedJobsResponse = {
  ok: true
  result: null
}

export type DeleteStoredJobsRequest = {
  name: QueueName
}

export type DeleteStoredJobsResponse = {
  ok: true
  result: null
}

export type DeleteAllJobsRequest = {
  name?: QueueName
}

export type DeleteAllJobsResponse = {
  ok: true
  result: null
}

export type CompleteOptions = {
  includeQueued?: boolean
}

export type CompleteRequest = {
  name: QueueName
  id: string | string[]
  data?: NullableJsonRecord
  options?: CompleteOptions
}

export type CompleteResponse = {
  ok: true
  result: CommandResponse
}

export type FailRequest = {
  name: QueueName
  id: string | string[]
  data?: NullableJsonRecord
}

export type FailResponse = {
  ok: true
  result: CommandResponse
}

export type FindJobsResponse = {
  ok: true
  result: JobWithMetadata[]
}

export type CreateQueueRequest = {
  name: QueueName
  options?: QueueOptions & {
    policy?: string
    partition?: boolean
    deadLetter?: string
    warningQueueSize?: number
  }
}

export type CreateQueueResponse = {
  ok: true
  result: null
}

export type GetBlockedKeysResponse = {
  ok: true
  result: string[]
}

export type UpdateQueueRequest = {
  name: QueueName
  options?: UpdateQueueOptions
}

export type UpdateQueueResponse = {
  ok: true
  result: null
}

export type DeleteQueueRequest = {
  name: QueueName
}

export type DeleteQueueResponse = {
  ok: true
  result: null
}

export type GetQueuesResponse = {
  ok: true
  result: QueueResult[]
}

export type GetQueueResponse = {
  ok: true
  result: QueueResult | null
}

export type GetQueueStatsResponse = {
  ok: true
  result: QueueResult
}

export type SuperviseRequest = {
  name?: QueueName
}

export type SuperviseResponse = {
  ok: true
  result: null
}

export type IsInstalledResponse = {
  ok: true
  result: boolean
}

export type SchemaVersionResponse = {
  ok: true
  result: number | null
}

export type ScheduleRequest = {
  name: QueueName
  cron: string
  data?: NullableJsonRecord
  options?: ScheduleOptions
}

export type ScheduleResponse = {
  ok: true
  result: null
}

export type UnscheduleRequest = {
  name: QueueName
  key?: string
}

export type UnscheduleResponse = {
  ok: true
  result: null
}

export type GetSchedulesResponse = {
  ok: true
  result: Schedule[]
}

export type GetBamStatusResponse = {
  ok: true
  result: BamStatusSummary[]
}
