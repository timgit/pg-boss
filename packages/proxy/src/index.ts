import { version } from '../package.json'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import {
  PgBoss,
  events,
  policies,
  states,
  type ConstructorOptions
} from 'pg-boss'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
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
  errorResultSchema,
  failRequestSchema,
  failResponseSchema,
  fetchRequestSchema,
  fetchResponseSchema,
  findJobsRequestSchema,
  findJobsResponseSchema,
  getBamStatusResponseSchema,
  getBlockedKeysRequestSchema,
  getBlockedKeysResponseSchema,
  getQueueRequestSchema,
  getQueueResponseSchema,
  getQueuesRequestSchema,
  getQueuesResponseSchema,
  getQueueStatsRequestSchema,
  getQueueStatsResponseSchema,
  getSchedulesRequestSchema,
  getSchedulesResponseSchema,
  htmlResponseSchema,
  insertRequestSchema,
  insertResponseSchema,
  isInstalledResponseSchema,
  metaResponseSchema,
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
import { renderHome } from './home.js'

const withBody = <Method extends string, Schema extends z.ZodTypeAny>(
  method: Method,
  request: Schema,
  response: z.ZodTypeAny,
  args: (body: z.infer<Schema>) => unknown[]
) => ({
    method,
    request,
    response,
    args: (body: unknown) => args(body as z.infer<Schema>)
  })

const noBody = <Method extends string>(
  method: Method,
  response: z.ZodTypeAny,
  args: () => unknown[]
) => ({
    method,
    response,
    args
  })

const withOptionalDataOptions = (args: unknown[], data?: unknown, options?: unknown) => {
  if (data !== undefined || options !== undefined) {
    args.push(data ?? null)
  }
  if (options !== undefined) {
    args.push(options)
  }
  return args
}

const withFixedDataOptions = (args: unknown[], data?: unknown, options?: unknown, tail: unknown[] = []) => {
  return [...args, data ?? null, options ?? null, ...tail]
}

const withOptionalOptions = (args: unknown[], options?: unknown) => {
  if (options !== undefined) {
    args.push(options)
  }
  return args
}

const bodyMethods = [
  withBody('send', sendRequestSchema, sendResponseSchema, (body) => withOptionalDataOptions([body.name], body.data, body.options)),
  withBody('sendAfter', sendAfterRequestSchema, sendAfterResponseSchema, (body) => withFixedDataOptions([body.name], body.data, body.options, [body.after])),
  withBody('sendThrottled', sendThrottledRequestSchema, sendThrottledResponseSchema, (body) => withFixedDataOptions([body.name], body.data, body.options, [body.seconds, body.key])),
  withBody('sendDebounced', sendDebouncedRequestSchema, sendDebouncedResponseSchema, (body) => withFixedDataOptions([body.name], body.data, body.options, [body.seconds, body.key])),
  withBody('insert', insertRequestSchema, insertResponseSchema, (body) => withOptionalOptions([body.name, body.jobs], body.options)),
  withBody('fetch', fetchRequestSchema, fetchResponseSchema, (body) => withOptionalOptions([body.name], body.options)),
  withBody('subscribe', subscribeRequestSchema, subscribeResponseSchema, (body) => [body.event, body.name]),
  withBody('unsubscribe', unsubscribeRequestSchema, unsubscribeResponseSchema, (body) => [body.event, body.name]),
  withBody('publish', publishRequestSchema, publishResponseSchema, (body) => withOptionalDataOptions([body.event], body.data, body.options)),
  withBody('cancel', cancelRequestSchema, cancelResponseSchema, (body) => withOptionalOptions([body.name, body.id], body.options)),
  withBody('resume', resumeRequestSchema, resumeResponseSchema, (body) => withOptionalOptions([body.name, body.id], body.options)),
  withBody('retry', retryRequestSchema, retryResponseSchema, (body) => withOptionalOptions([body.name, body.id], body.options)),
  withBody('deleteJob', deleteJobRequestSchema, deleteJobResponseSchema, (body) => withOptionalOptions([body.name, body.id], body.options)),
  withBody('deleteQueuedJobs', deleteQueuedJobsRequestSchema, deleteQueuedJobsResponseSchema, (body) => [body.name]),
  withBody('deleteStoredJobs', deleteStoredJobsRequestSchema, deleteStoredJobsResponseSchema, (body) => [body.name]),
  withBody('deleteAllJobs', deleteAllJobsRequestSchema, deleteAllJobsResponseSchema, (body) => (body.name ? [body.name] : [])),
  withBody('complete', completeRequestSchema, completeResponseSchema, (body) => withOptionalDataOptions([body.name, body.id], body.data, body.options)),
  withBody('fail', failRequestSchema, failResponseSchema, (body) => withOptionalDataOptions([body.name, body.id], body.data, body.options)),
  withBody('findJobs', findJobsRequestSchema, findJobsResponseSchema, (body) => withOptionalOptions([body.name], body.options)),
  withBody('createQueue', createQueueRequestSchema, createQueueResponseSchema, (body) => withOptionalOptions([body.name], body.options)),
  withBody('getBlockedKeys', getBlockedKeysRequestSchema, getBlockedKeysResponseSchema, (body) => [body.name]),
  withBody('updateQueue', updateQueueRequestSchema, updateQueueResponseSchema, (body) => withOptionalOptions([body.name], body.options)),
  withBody('deleteQueue', deleteQueueRequestSchema, deleteQueueResponseSchema, (body) => [body.name]),
  withBody('getQueues', getQueuesRequestSchema, getQueuesResponseSchema, (body) => (body.names ? [body.names] : [])),
  withBody('getQueue', getQueueRequestSchema, getQueueResponseSchema, (body) => [body.name]),
  withBody('getQueueStats', getQueueStatsRequestSchema, getQueueStatsResponseSchema, (body) => [body.name]),
  withBody('supervise', superviseRequestSchema, superviseResponseSchema, (body) => (body.name ? [body.name] : [])),
  withBody('schedule', scheduleRequestSchema, scheduleResponseSchema, (body) => withOptionalDataOptions([body.name, body.cron], body.data, body.options)),
  withBody('unschedule', unscheduleRequestSchema, unscheduleResponseSchema, (body) => (body.key ? [body.name, body.key] : [body.name])),
  withBody('getSchedules', getSchedulesRequestSchema, getSchedulesResponseSchema, (body) => (body.name && body.key) ? [body.name, body.key] : (body.name) ? [body.name] : [])
]

const noBodyMethods = [
  noBody('isInstalled', isInstalledResponseSchema, () => []),
  noBody('schemaVersion', schemaVersionResponseSchema, () => []),
  noBody('getBamStatus', getBamStatusResponseSchema, () => [])
]

type BossMethod = (typeof bodyMethods)[number]['method'] | (typeof noBodyMethods)[number]['method']

const bossMethods: BossMethod[] = [...bodyMethods, ...noBodyMethods].map((entry) => entry.method)

type ProxyOptions = {
  options: ConstructorOptions
  bossFactory?: (options: ConstructorOptions) => PgBoss
  prefix?: string
}

type ProxyApp = {
  app: OpenAPIHono
  boss: PgBoss
  prefix: string
}

type ProxyService = ProxyApp & {
  start: () => Promise<void>
  stop: () => Promise<void>
}

type ShutdownHandler = () => void | Promise<void>

type ShutdownAdapter<Signal> = {
  on: (signal: Signal, handler: () => void) => void
  off?: (signal: Signal, handler: () => void) => void
}

const attachShutdownListeners = <Signal>(
  signals: Signal[],
  adapter: ShutdownAdapter<Signal>,
  handler: ShutdownHandler
) => {
  const wrapped = () => {
    handler()
  }

  for (const signal of signals) {
    adapter.on(signal, wrapped)
  }

  return () => {
    if (!adapter.off) {
      return
    }
    for (const signal of signals) {
      adapter.off(signal, wrapped)
    }
  }
}

const normalizePrefix = (prefix: string): string => {
  const normalized = prefix.startsWith('/') ? prefix : `/${prefix}`
  return normalized === '/' ? '' : normalized.replace(/\/$/, '')
}

const errorResponse = <Status extends ContentfulStatusCode>(
  context: Context,
  status: Status,
  message: string
) => {
  return context.json({ ok: false, error: { message } }, status)
}

const resultResponse = (context: Context, result: unknown) => {
  return context.json({ ok: true, result: result ?? null }, 200)
}

export const createProxyApp = (options: ProxyOptions): ProxyApp => {
  const providedOptions = options.options ?? {}
  const resolvedOptions: ConstructorOptions = {
    ...providedOptions,
    supervise: false,
    migrate: false,
    schedule: false
  }

  let boss: PgBoss

  if (options.bossFactory) {
    boss = options.bossFactory(resolvedOptions)
  } else {
    if (Object.keys(providedOptions).length === 0) {
      throw new Error('Proxy requires PgBoss constructor options.')
    }
    boss = new PgBoss(resolvedOptions)
  }
  const prefix = normalizePrefix(options.prefix ?? '/api')
  const app = new OpenAPIHono()
  const base = prefix || '/'

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'pg-boss proxy',
      version,
      description: 'HTTP proxy for pg-boss methods.'
    }
  })

  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  app.onError((error, context) => {
    return errorResponse(context, 500, error.message)
  })

  const homeRoute = createRoute({
    method: 'get',
    path: '/',
    responses: {
      200: {
        description: 'Home page',
        content: {
          'text/html': {
            schema: htmlResponseSchema
          }
        }
      }
    }
  })

  app.openapi(homeRoute, (context) => {
    return context.html(renderHome({ base, methods: bossMethods }))
  })

  const metaRoute = createRoute({
    method: 'get',
    path: `${prefix}/meta`,
    responses: {
      200: {
        description: 'Metadata for pg-boss enumerations',
        content: {
          'application/json': {
            schema: metaResponseSchema
          }
        }
      }
    }
  })

  app.openapi(metaRoute, (context) => {
    return context.json({ ok: true, result: { states, policies, events } }, 200)
  })

  const registerMethodRouteWithBody = (
    method: BossMethod,
    requestSchema: z.ZodTypeAny,
    responseSchema: z.ZodTypeAny,
    buildArgs: (body: unknown) => unknown[]
  ) => {
    const route = createRoute({
      method: 'post',
      path: `${prefix}/${method}`,
      request: {
        body: {
          content: {
            'application/json': {
              schema: requestSchema
            }
          },
          description: 'Arguments to pass through to the pg-boss method'
        }
      },
      responses: {
        200: {
          description: 'Method response',
          content: {
            'application/json': {
              schema: responseSchema
            }
          }
        },
        400: {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: errorResultSchema
            }
          }
        },
        500: {
          description: 'Server error',
          content: {
            'application/json': {
              schema: errorResultSchema
            }
          }
        }
      }
    })

    app.openapi(route, async (context) => {
      let body: unknown

      try {
        body = requestSchema.parse(await context.req.json())
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return errorResponse(context, 400, message)
      }

      const args = buildArgs(body)

      try {
        const result = await (boss[method] as (...methodArgs: unknown[]) => Promise<unknown> | unknown)(...args)
        return resultResponse(context, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return errorResponse(context, 500, message)
      }
    })
  }

  const registerMethodRouteNoBody = (
    method: BossMethod,
    responseSchema: z.ZodTypeAny,
    buildArgs: () => unknown[]
  ) => {
    const route = createRoute({
      method: 'post',
      path: `${prefix}/${method}`,
      responses: {
        200: {
          description: 'Method response',
          content: {
            'application/json': {
              schema: responseSchema
            }
          }
        },
        500: {
          description: 'Server error',
          content: {
            'application/json': {
              schema: errorResultSchema
            }
          }
        }
      }
    })

    app.openapi(route, async (context) => {
      const args = buildArgs()

      try {
        const result = await (boss[method] as (...methodArgs: unknown[]) => Promise<unknown> | unknown)(...args)
        return resultResponse(context, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return errorResponse(context, 500, message)
      }
    })
  }

  for (const { method, request, response, args } of bodyMethods) {
    registerMethodRouteWithBody(method, request, response, args)
  }

  for (const { method, response, args } of noBodyMethods) {
    registerMethodRouteNoBody(method, response, args)
  }

  return { app, boss, prefix }
}

export const createProxyService = (options: ProxyOptions): ProxyService => {
  const proxy = createProxyApp(options)
  return {
    ...proxy,
    start: async () => {
      await proxy.boss.start()
    },
    stop: async () => {
      await proxy.boss.stop()
    }
  }
}

export { attachShutdownListeners }

export type { ProxyApp, ProxyOptions, ProxyService, ShutdownHandler, ShutdownAdapter }
