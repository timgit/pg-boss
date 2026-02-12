import { z } from '@hono/zod-openapi'
import {
  cancelRequestSchema,
  cancelResponseSchema,
  completeRequestSchema,
  completeResponseSchema,
  createQueueRequestSchema,
  createQueueResponseSchema,
  deleteAllJobsRequestSchema,
  deleteAllJobsResponseSchema,
  deleteJobRequestSchema,
  deleteJobResponseSchema,
  deleteQueueRequestSchema,
  deleteQueueResponseSchema,
  deleteQueuedJobsRequestSchema,
  deleteQueuedJobsResponseSchema,
  deleteStoredJobsRequestSchema,
  deleteStoredJobsResponseSchema,
  failRequestSchema,
  failResponseSchema,
  fetchRequestSchema,
  fetchResponseSchema,
  findJobsResponseSchema,
  getBamStatusResponseSchema,
  getBlockedKeysResponseSchema,
  getQueueResponseSchema,
  getQueueStatsResponseSchema,
  getQueuesResponseSchema,
  getSchedulesResponseSchema,
  insertRequestSchema,
  insertResponseSchema,
  isInstalledResponseSchema,
  publishRequestSchema,
  publishResponseSchema,
  resumeRequestSchema,
  resumeResponseSchema,
  retryRequestSchema,
  retryResponseSchema,
  scheduleRequestSchema,
  scheduleResponseSchema,
  schemaVersionResponseSchema,
  sendAfterRequestSchema,
  sendAfterResponseSchema,
  sendDebouncedRequestSchema,
  sendDebouncedResponseSchema,
  sendRequestSchema,
  sendResponseSchema,
  sendThrottledRequestSchema,
  sendThrottledResponseSchema,
  subscribeRequestSchema,
  subscribeResponseSchema,
  superviseRequestSchema,
  superviseResponseSchema,
  unsubscribeRequestSchema,
  unsubscribeResponseSchema,
  unscheduleRequestSchema,
  unscheduleResponseSchema,
  updateQueueRequestSchema,
  updateQueueResponseSchema
} from './contracts.zod.js'

export const withOptionalDataOptions = (args: unknown[], data?: unknown, options?: unknown) => {
  if (data !== undefined || options !== undefined) {
    args.push(data ?? null)
  }
  if (options !== undefined) {
    args.push(options)
  }
  return args
}

export const withFixedDataOptions = (args: unknown[], data?: unknown, options?: unknown, tail: unknown[] = []) => {
  const result = [...args, data ?? null, options ?? null, ...tail]
  while (result.length > 0 && result[result.length - 1] === undefined) {
    result.pop()
  }
  return result
}

export const withOptionalOptions = (args: unknown[], options?: unknown) => {
  if (options !== undefined) {
    args.push(options)
  }
  return args
}

export type RouteEntry = {
  method: string
  httpMethod: 'get' | 'post'
  tag: string
  request?: z.ZodTypeAny
  querySchema?: z.ZodTypeAny
  response: z.ZodTypeAny
  args: (input?: unknown) => unknown[]
}

const post = <Schema extends z.ZodTypeAny>(
  tag: string,
  method: string,
  request: Schema,
  response: z.ZodTypeAny,
  args: (body: z.infer<Schema>) => unknown[]
): RouteEntry => ({
    method,
    httpMethod: 'post',
    tag,
    request,
    response,
    args: (body: unknown) => args(body as z.infer<Schema>)
  })

const get = (
  tag: string,
  method: string,
  response: z.ZodTypeAny,
  querySchema?: z.ZodTypeAny,
  args?: (query: Record<string, unknown>) => unknown[]
): RouteEntry => ({
  method,
  httpMethod: 'get',
  tag,
  querySchema,
  response,
  args: args
    ? (query: unknown) => args(query as Record<string, unknown>)
    : () => []
})

// Query schemas for GET endpoints (transport-layer schemas with string coercion)
const nameQuerySchema = z.object({
  name: z.string().min(1)
})

const namesQuerySchema = z.object({
  names: z.union([z.array(z.string()), z.string().transform((s) => [s])]).optional()
})

const schedulesQuerySchema = z.object({
  name: z.string().optional(),
  key: z.string().optional()
})

const findJobsQuerySchema = z.object({
  name: z.string().min(1),
  id: z.string().optional(),
  key: z.string().optional(),
  queued: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  dataKey: z.string().optional(),
  dataValue: z.string().optional()
}).refine((q) => !q.dataValue || q.dataKey, {
  message: 'dataKey is required when dataValue is provided'
})

const blockedKeysQuerySchema = z.object({
  name: z.string().min(1)
})

export const postMethods: RouteEntry[] = [
  post('jobs', 'send', sendRequestSchema, sendResponseSchema, (body) => withOptionalDataOptions([body.name], body.data, body.options)),
  post('jobs', 'sendAfter', sendAfterRequestSchema, sendAfterResponseSchema, (body) => withFixedDataOptions([body.name], body.data, body.options, [body.after])),
  post('jobs', 'sendThrottled', sendThrottledRequestSchema, sendThrottledResponseSchema, (body) => withFixedDataOptions([body.name], body.data, body.options, [body.seconds, body.key])),
  post('jobs', 'sendDebounced', sendDebouncedRequestSchema, sendDebouncedResponseSchema, (body) => withFixedDataOptions([body.name], body.data, body.options, [body.seconds, body.key])),
  post('jobs', 'insert', insertRequestSchema, insertResponseSchema, (body) => withOptionalOptions([body.name, body.jobs], body.options)),
  post('jobs', 'fetch', fetchRequestSchema, fetchResponseSchema, (body) => withOptionalOptions([body.name], body.options)),
  post('jobs', 'complete', completeRequestSchema, completeResponseSchema, (body) => withOptionalDataOptions([body.name, body.id], body.data, body.options)),
  post('jobs', 'fail', failRequestSchema, failResponseSchema, (body) => {
    const args: unknown[] = [body.name, body.id]
    if (body.data !== undefined) args.push(body.data ?? null)
    return args
  }),
  post('jobs', 'cancel', cancelRequestSchema, cancelResponseSchema, (body) => [body.name, body.id]),
  post('jobs', 'resume', resumeRequestSchema, resumeResponseSchema, (body) => [body.name, body.id]),
  post('jobs', 'retry', retryRequestSchema, retryResponseSchema, (body) => [body.name, body.id]),
  post('jobs', 'deleteJob', deleteJobRequestSchema, deleteJobResponseSchema, (body) => [body.name, body.id]),
  post('jobs', 'deleteQueuedJobs', deleteQueuedJobsRequestSchema, deleteQueuedJobsResponseSchema, (body) => [body.name]),
  post('jobs', 'deleteStoredJobs', deleteStoredJobsRequestSchema, deleteStoredJobsResponseSchema, (body) => [body.name]),
  post('jobs', 'deleteAllJobs', deleteAllJobsRequestSchema, deleteAllJobsResponseSchema, (body) => (body.name ? [body.name] : [])),
  post('queues', 'createQueue', createQueueRequestSchema, createQueueResponseSchema, (body) => withOptionalOptions([body.name], body.options)),
  post('queues', 'updateQueue', updateQueueRequestSchema, updateQueueResponseSchema, (body) => withOptionalOptions([body.name], body.options)),
  post('queues', 'deleteQueue', deleteQueueRequestSchema, deleteQueueResponseSchema, (body) => [body.name]),
  post('events', 'subscribe', subscribeRequestSchema, subscribeResponseSchema, (body) => [body.event, body.name]),
  post('events', 'unsubscribe', unsubscribeRequestSchema, unsubscribeResponseSchema, (body) => [body.event, body.name]),
  post('events', 'publish', publishRequestSchema, publishResponseSchema, (body) => withOptionalDataOptions([body.event], body.data, body.options)),
  post('schedules', 'schedule', scheduleRequestSchema, scheduleResponseSchema, (body) => withOptionalDataOptions([body.name, body.cron], body.data, body.options)),
  post('schedules', 'unschedule', unscheduleRequestSchema, unscheduleResponseSchema, (body) => (body.key ? [body.name, body.key] : [body.name])),
  post('system', 'supervise', superviseRequestSchema, superviseResponseSchema, (body) => (body.name ? [body.name] : []))
]

export const getMethods: RouteEntry[] = [
  get('system', 'isInstalled', isInstalledResponseSchema),
  get('system', 'schemaVersion', schemaVersionResponseSchema),
  get('system', 'getBamStatus', getBamStatusResponseSchema),
  get('queues', 'getQueue', getQueueResponseSchema, nameQuerySchema, (q) => [q.name]),
  get('queues', 'getQueueStats', getQueueStatsResponseSchema, nameQuerySchema, (q) => [q.name]),
  get('queues', 'getBlockedKeys', getBlockedKeysResponseSchema, blockedKeysQuerySchema, (q) => [q.name]),
  get('queues', 'getQueues', getQueuesResponseSchema, namesQuerySchema, (q) => (q.names ? [q.names] : [])),
  get('schedules', 'getSchedules', getSchedulesResponseSchema, schedulesQuerySchema, (q) => {
    if (q.name && q.key) return [q.name, q.key]
    if (q.name) return [q.name]
    return []
  }),
  get('jobs', 'findJobs', findJobsResponseSchema, findJobsQuerySchema, (q) => {
    const args: unknown[] = [q.name]
    const options: Record<string, unknown> = {}
    if (q.id) options.id = q.id
    if (q.key) options.key = q.key
    if (q.queued !== undefined) options.queued = q.queued
    if (q.dataKey) options.data = { [q.dataKey as string]: q.dataValue ?? null }
    if (Object.keys(options).length > 0) args.push(options)
    return args
  })
]

export const allRoutes: RouteEntry[] = [...postMethods, ...getMethods]

export const bossMethodNames: string[] = allRoutes.map((entry) => entry.method)

export const bossMethodInfos: { method: string, httpMethod: 'get' | 'post' }[] = allRoutes.map((entry) => ({
  method: entry.method,
  httpMethod: entry.httpMethod
}))
