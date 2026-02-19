import { version } from './version.js'
import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import {
  PgBoss,
  events,
  policies,
  states,
  type ConstructorOptions
} from 'pg-boss'
import type { Context, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  errorResultSchema,
  htmlResponseSchema,
  metaResponseSchema
} from './contracts.js'
import { renderHome } from './home.js'
import { allRoutes, type RouteEntry } from './routes.js'
import { configureAuth } from './auth.js'
import { configureCors } from './cors.js'
import { getLogger } from '@logtape/logtape'
import { honoLogger } from '@logtape/hono'

type ProxyEnv = Record<string, string | undefined>

type ProxyOptions = {
  options?: ConstructorOptions
  bossFactory?: (options: ConstructorOptions) => PgBoss
  prefix?: string
  env?: ProxyEnv
  middleware?: MiddlewareHandler | MiddlewareHandler[]
  requestLogger?: boolean
  exposeErrors?: boolean
  bodyLimit?: number
  routes?: {
    allow?: string[]
    deny?: string[]
  }
  pages?: {
    root?: boolean
    docs?: boolean
    openapi?: boolean
  }
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

const normalizePrefix = (prefix: string): string => {
  const normalized = prefix.startsWith('/') ? prefix : `/${prefix}`
  return normalized === '/' ? '' : normalized.replace(/\/$/, '')
}

const resolvePrefix = (prefix: string | undefined) => {
  return normalizePrefix(prefix ?? '/api')
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
  const envOptions = options.env?.DATABASE_URL
    ? { connectionString: options.env.DATABASE_URL }
    : undefined
  const providedOptions = options.options ?? envOptions ?? {}
  const exposeErrors = options.exposeErrors ?? false

  const resolvedOptions: ConstructorOptions = { ...providedOptions }

  if (!('supervise' in providedOptions)) {
    resolvedOptions.supervise = false
  }
  if (!('migrate' in providedOptions)) {
    resolvedOptions.migrate = false
  }
  if (!('schedule' in providedOptions)) {
    resolvedOptions.schedule = false
  }

  const prefix = resolvePrefix(options.prefix)

  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (!result.success) {
        const message = result.error instanceof Error ? result.error.message : 'Validation error'
        return context.json({ ok: false, error: { message } }, 400)
      }
    }
  })

  const requestLogger = options.requestLogger ?? true

  if (requestLogger) {
    app.use('*', honoLogger())
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

  boss.on('error', (error) => {
    const logger = getLogger(['pg-boss', 'proxy'])
    logger.error(error as Error)
  })

  configureAuth(app, options.env ?? process.env, prefix)
  configureCors(app, options.env ?? process.env, prefix)

  const base = prefix || '/'

  const openapiPath = '/openapi.json'
  const docsPath = '/docs'

  const pages = options.pages ?? {}

  if (pages.openapi !== false) {
    app.doc31(openapiPath, {
      openapi: '3.1.0',
      info: {
        title: 'pg-boss proxy',
        version,
        description: 'HTTP proxy for pg-boss methods.'
      }
    })
  }

  if (pages.docs !== false) {
    app.get(docsPath, swaggerUI({ url: openapiPath }))
  }

  app.onError((error, context) => {
    const message = exposeErrors && error instanceof Error
      ? error.message
      : 'Internal server error'
    return errorResponse(context, 500, message)
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

  const applyRouteFilter = (routes: RouteEntry[]) => {
    let result = routes
    const allow = options.routes?.allow
    const deny = options.routes?.deny
    if (allow && allow.length > 0) {
      result = result.filter((entry) => allow.includes(entry.method))
    }
    if (deny && deny.length > 0) {
      result = result.filter((entry) => !deny.includes(entry.method))
    }
    return result
  }

  const enabledRoutes = applyRouteFilter(allRoutes)
  const enabledMethodInfos = enabledRoutes.map(({ method, httpMethod }) => ({ method, httpMethod }))

  const homeHtml = renderHome({ base, openapiPath, docsPath, methods: enabledMethodInfos })

  if (pages.root !== false) {
    app.openapi(homeRoute, (context) => {
      return context.html(homeHtml)
    })
  }

  const maxBodySize = options.bodyLimit ?? 1024 * 1024
  app.use(`${prefix}/*`, async (context, next) => {
    if (context.req.method === 'POST') {
      const contentLength = context.req.header('content-length')
      if (contentLength && parseInt(contentLength, 10) > maxBodySize) {
        return context.json({ ok: false, error: { message: `Request body too large (max ${maxBodySize} bytes)` } }, 413)
      }
    }
    await next()
  })

  if (options.middleware) {
    const middlewares = Array.isArray(options.middleware) ? options.middleware : [options.middleware]
    for (const mw of middlewares) {
      app.use(`${prefix}/*`, mw)
    }
  }

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

  const registerRoute = (entry: RouteEntry) => {
    const { method, httpMethod, tag, request, querySchema, response, args: buildArgs } = entry

    const responses: Record<number, unknown> = {
      200: {
        description: 'Method response',
        content: {
          'application/json': {
            schema: response
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

    if (httpMethod === 'post' && request) {
      responses[400] = {
        description: 'Invalid request',
        content: {
          'application/json': {
            schema: errorResultSchema
          }
        }
      }
    }

    if (httpMethod === 'get' && querySchema) {
      responses[400] = {
        description: 'Invalid query parameters',
        content: {
          'application/json': {
            schema: errorResultSchema
          }
        }
      }
    }

    const routeDef: Record<string, unknown> = {
      method: httpMethod,
      path: `${prefix}/${method}`,
      tags: [tag],
      operationId: method,
      responses
    }

    if (httpMethod === 'post' && request) {
      routeDef.request = {
        body: {
          content: {
            'application/json': {
              schema: request
            }
          },
          description: 'Arguments to pass through to the pg-boss method'
        }
      }
    }

    if (httpMethod === 'get' && querySchema) {
      routeDef.request = {
        query: querySchema
      }
    }

    const route = createRoute(routeDef as Parameters<typeof createRoute>[0])

    app.openapi(route, async (context) => {
      let args: unknown[]

      if (httpMethod === 'post' && request) {
        const input = context.req.valid('json' as never)
        args = buildArgs(input)
      } else if (httpMethod === 'get' && querySchema) {
        try {
          const raw = context.req.queries()
          const flat: Record<string, string | string[]> = {}
          for (const [key, values] of Object.entries(raw)) {
            flat[key] = values.length === 1 ? values[0] : values
          }
          const input = querySchema.parse(flat)
          args = buildArgs(input)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid query parameters'
          return errorResponse(context, 400, message)
        }
      } else {
        args = buildArgs()
      }

      try {
        const result = await (boss[method as keyof PgBoss] as (...methodArgs: unknown[]) => Promise<unknown> | unknown)(...args)
        return resultResponse(context, result)
      } catch (error) {
        const message = exposeErrors && error instanceof Error
          ? error.message
          : 'Internal server error'
        return errorResponse(context, 500, message)
      }
    })
  }

  for (const entry of enabledRoutes) {
    registerRoute(entry)
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

export { bossMethodNames, bossMethodInfos } from './routes.js'
export { configureAuth } from './auth.js'
export { configureCors } from './cors.js'
export { honoLogger } from '@logtape/hono'
export {
  attachShutdownListeners,
  nodeShutdownAdapter,
  bunShutdownAdapter,
  createDenoShutdownAdapter
} from './shutdown.js'

export type { ProxyApp, ProxyOptions, ProxyService }
export type { ShutdownHandler, ShutdownAdapter } from './shutdown.js'
