import type * as types from 'pg-boss'

export type HttpJsonRecord = Record<string, unknown>
export type HttpNullableJsonRecord = HttpJsonRecord | null
export type HttpDateInput = string | number

/**
 * @minLength 1
 */
export type HttpQueueName = string

/**
 * @minLength 1
 */
export type HttpEventName = string

export type HttpErrorResult = {
  ok: false
  error: { message: string }
}

export type HttpHtmlResponse = string

export type HttpGroupOptions = types.GroupOptions

export type HttpGroupConcurrencyConfig = types.GroupConcurrencyConfig

export type HttpQueueOptions = types.QueueOptions

export type HttpJobOptions = types.JobOptions

export type HttpSendOptions = Omit<types.SendOptions, 'db'>

export type HttpScheduleOptions = Omit<types.ScheduleOptions, 'db'>

export type HttpFetchOptions = Omit<types.FetchOptions, 'db'>

export type HttpFindJobsOptions = Omit<types.FindJobsOptions, 'db' | 'data'> & {
  data?: HttpJsonRecord
}

export type HttpInsertOptions = Omit<types.InsertOptions, 'db'>

export type HttpCompleteOptions = Omit<types.CompleteOptions, 'db'>

export type HttpJobInsert = types.JobInsert<HttpJsonRecord>

export type HttpJob = Omit<types.Job<HttpJsonRecord>, 'signal'>

export type HttpJobWithMetadata = Omit<
  types.JobWithMetadata<HttpJsonRecord>,
  'signal' | 'heartbeatOn' | 'singletonOn' | 'output'
> & {
  singletonOn: string | null
  output: HttpJsonRecord
}

export type HttpCommandResponse = types.CommandResponse

export type HttpQueueResult = types.QueueResult

export type HttpSchedule = Omit<types.Schedule, 'data' | 'options'> & {
  data?: HttpJsonRecord
  options?: HttpSendOptions
}

export type HttpBamStatusSummary = types.BamStatusSummary

export type HttpMetaResult = {
  states: Record<string, string>
  policies: Record<string, string>
  events: Record<string, string>
}

export type HttpMetaResponse = {
  ok: true
  result: HttpMetaResult
}

export type HttpSendRequest = {
  name: HttpQueueName
  data?: HttpNullableJsonRecord
  options?: HttpSendOptions
}

export type HttpSendResponse = {
  ok: true
  result: string | null
}

export type HttpSendAfterRequest = {
  name: HttpQueueName
  data?: HttpNullableJsonRecord
  options?: HttpSendOptions | null
  after: HttpDateInput
}

export type HttpSendAfterResponse = HttpSendResponse

export type HttpSendThrottledRequest = {
  name: HttpQueueName
  data?: HttpNullableJsonRecord
  options?: HttpSendOptions | null
  seconds: number
  key?: string
}

export type HttpSendThrottledResponse = HttpSendResponse

export type HttpSendDebouncedRequest = {
  name: HttpQueueName
  data?: HttpNullableJsonRecord
  options?: HttpSendOptions | null
  seconds: number
  key?: string
}

export type HttpSendDebouncedResponse = HttpSendResponse

export type HttpInsertRequest = {
  name: HttpQueueName
  jobs: HttpJobInsert[]
  options?: HttpInsertOptions
}

export type HttpInsertResponse = {
  ok: true
  result: string[] | null
}

export type HttpFetchRequest = {
  name: HttpQueueName
  options?: HttpFetchOptions
}

export type HttpFetchResponse = {
  ok: true
  result: HttpJobWithMetadata[] | HttpJob[]
}

export type HttpSubscribeRequest = {
  event: HttpEventName
  name: HttpQueueName
}

export type HttpSubscribeResponse = {
  ok: true
  result: null
}

export type HttpUnsubscribeRequest = HttpSubscribeRequest

export type HttpUnsubscribeResponse = HttpSubscribeResponse

export type HttpPublishRequest = {
  event: HttpEventName
  data?: HttpNullableJsonRecord
  options?: HttpSendOptions
}

export type HttpPublishResponse = HttpSubscribeResponse

export type HttpCancelRequest = {
  name: HttpQueueName
  id: string | string[]
}

export type HttpCancelResponse = {
  ok: true
  result: HttpCommandResponse
}

export type HttpResumeRequest = HttpCancelRequest

export type HttpResumeResponse = HttpCancelResponse

export type HttpRetryRequest = HttpCancelRequest

export type HttpRetryResponse = HttpCancelResponse

export type HttpDeleteJobRequest = HttpCancelRequest

export type HttpDeleteJobResponse = HttpCancelResponse

export type HttpDeleteQueuedJobsRequest = {
  name: HttpQueueName
}

export type HttpDeleteQueuedJobsResponse = HttpSubscribeResponse

export type HttpDeleteStoredJobsRequest = {
  name: HttpQueueName
}

export type HttpDeleteStoredJobsResponse = HttpSubscribeResponse

export type HttpDeleteAllJobsRequest = {
  name?: HttpQueueName
}

export type HttpDeleteAllJobsResponse = HttpSubscribeResponse

export type HttpCompleteRequest = {
  name: HttpQueueName
  id: string | string[]
  data?: HttpNullableJsonRecord
  options?: HttpCompleteOptions
}

export type HttpCompleteResponse = HttpCancelResponse

export type HttpFailRequest = {
  name: HttpQueueName
  id: string | string[]
  data?: HttpNullableJsonRecord
}

export type HttpFailResponse = HttpCancelResponse

export type HttpFindJobsResponse = {
  ok: true
  result: HttpJobWithMetadata[]
}

export type HttpCreateQueueOptions = HttpQueueOptions & {
  policy?: string
  partition?: boolean
  deadLetter?: string
  warningQueueSize?: number
}

export type HttpCreateQueueRequest = {
  name: HttpQueueName
  options?: HttpCreateQueueOptions
}

export type HttpCreateQueueResponse = HttpSubscribeResponse

export type HttpGetBlockedKeysResponse = {
  ok: true
  result: string[]
}

export type HttpUpdateQueueOptions = HttpQueueOptions & {
  deadLetter?: string
  warningQueueSize?: number
}

export type HttpUpdateQueueRequest = {
  name: HttpQueueName
  options?: HttpUpdateQueueOptions
}

export type HttpUpdateQueueResponse = HttpSubscribeResponse

export type HttpDeleteQueueRequest = {
  name: HttpQueueName
}

export type HttpDeleteQueueResponse = HttpSubscribeResponse

export type HttpGetQueuesResponse = {
  ok: true
  result: HttpQueueResult[]
}

export type HttpGetQueueResponse = {
  ok: true
  result: HttpQueueResult | null
}

export type HttpGetQueueStatsResponse = {
  ok: true
  result: HttpQueueResult
}

export type HttpSuperviseRequest = {
  name?: HttpQueueName
}

export type HttpSuperviseResponse = HttpSubscribeResponse

export type HttpIsInstalledResponse = {
  ok: true
  result: boolean
}

export type HttpSchemaVersionResponse = {
  ok: true
  result: number | null
}

export type HttpScheduleRequest = {
  name: HttpQueueName
  cron: string
  data?: HttpNullableJsonRecord
  options?: HttpScheduleOptions
}

export type HttpScheduleResponse = HttpSubscribeResponse

export type HttpUnscheduleRequest = {
  name: HttpQueueName
  key?: string
}

export type HttpUnscheduleResponse = HttpSubscribeResponse

export type HttpGetSchedulesResponse = {
  ok: true
  result: HttpSchedule[]
}

export type HttpGetBamStatusResponse = {
  ok: true
  result: HttpBamStatusSummary[]
}
