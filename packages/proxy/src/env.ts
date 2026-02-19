import type { MiddlewareHandler } from 'hono'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { basicAuth } from 'hono/basic-auth'
import { cors } from 'hono/cors'
import { configure, getConsoleSink, getLogger } from '@logtape/logtape'
import { bossMethodNames } from './routes.js'

type ProxyEnv = Record<string, string | undefined>

type AuthConfig = {
  username?: string
  password?: string
}

type CorsConfig = {
  origin?: string
  methods?: string
  headers?: string
  exposeHeaders?: string
  credentials?: boolean
  maxAge?: string
}

type LogFormat = 'text' | 'json'

type EnvConfig = {
  prefix?: string
  env?: ProxyEnv
  middleware?: MiddlewareHandler | MiddlewareHandler[]
  requestLogger?: boolean
  logFormat?: LogFormat
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
  auth?: AuthConfig
  cors?: CorsConfig
}

const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue
  return value.toLowerCase() === 'true'
}

const parseNumber = (value: string | undefined, defaultValue: number): number => {
  if (value === undefined) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) ? defaultValue : parsed
}

const parseString = (value: string | undefined, defaultValue: string): string => {
  return value ?? defaultValue
}

const parseStringArray = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

const parseBooleanOrUndefined = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined
  return value.toLowerCase() === 'true'
}

const parseLogFormat = (value: string | undefined): LogFormat | undefined => {
  if (!value) return undefined
  if (value === 'json' || value === 'text') return value
  return undefined
}

const validateRoutes = (allowed?: string[], denied?: string[]): void => {
  const validRoutes = new Set(bossMethodNames)
  const validRouteList = bossMethodNames.join(', ')
  const logger = getLogger(['pg-boss', 'proxy'])

  if (allowed) {
    for (const route of allowed) {
      if (!validRoutes.has(route)) {
        logger.warning(`Invalid route in PGBOSS_PROXY_ROUTES_ALLOW: "${route}" is not a valid route. Valid routes are: ${validRouteList}`)
      }
    }
  }

  if (denied) {
    for (const route of denied) {
      if (!validRoutes.has(route)) {
        logger.warning(`Invalid route in PGBOSS_PROXY_ROUTES_DENY: "${route}" is not a valid route. Valid routes are: ${validRouteList}`)
      }
    }
  }
}

export const configureFromEnv = (env: ProxyEnv): EnvConfig => {
  const prefix = parseString(env.PGBOSS_PROXY_PREFIX, '/api')
  const requestLogger = parseBoolean(env.PGBOSS_PROXY_REQUEST_LOGGER, true)
  const logFormat = parseLogFormat(env.PGBOSS_PROXY_LOG_FORMAT)
  const exposeErrors = parseBoolean(env.PGBOSS_PROXY_EXPOSE_ERRORS, false)
  const bodyLimit = parseNumber(env.PGBOSS_PROXY_BODY_LIMIT, 1024 * 1024)
  const routesAllow = parseStringArray(env.PGBOSS_PROXY_ROUTES_ALLOW)
  const routesDeny = parseStringArray(env.PGBOSS_PROXY_ROUTES_DENY)

  validateRoutes(routesAllow, routesDeny)

  const pageRoot = parseBooleanOrUndefined(env.PGBOSS_PROXY_PAGE_ROOT)
  const pageDocs = parseBooleanOrUndefined(env.PGBOSS_PROXY_PAGE_DOCS)
  const pageOpenapi = parseBooleanOrUndefined(env.PGBOSS_PROXY_PAGE_OPENAPI)

  const authUsername = env.PGBOSS_PROXY_AUTH_USERNAME
  const authPassword = env.PGBOSS_PROXY_AUTH_PASSWORD

  const config: EnvConfig = {
    prefix,
    requestLogger,
    logFormat,
    exposeErrors,
    bodyLimit,
    routes: {},
    pages: {},
    auth: {},
    cors: {}
  }

  if (routesAllow) {
    config.routes!.allow = routesAllow
  }

  if (routesDeny) {
    config.routes!.deny = routesDeny
  }

  if (pageRoot !== undefined) {
    config.pages!.root = pageRoot
  }

  if (pageDocs !== undefined) {
    config.pages!.docs = pageDocs
  }

  if (pageOpenapi !== undefined) {
    config.pages!.openapi = pageOpenapi
  }

  if (authUsername) {
    config.auth!.username = authUsername
  }

  if (authPassword) {
    config.auth!.password = authPassword
  }

  const corsOrigin = env.PGBOSS_PROXY_CORS_ORIGIN
  if (corsOrigin) {
    config.cors!.origin = corsOrigin
    config.cors!.methods = env.PGBOSS_PROXY_CORS_METHODS
    config.cors!.headers = env.PGBOSS_PROXY_CORS_HEADERS
    config.cors!.exposeHeaders = env.PGBOSS_PROXY_CORS_EXPOSE_HEADERS
    config.cors!.credentials = env.PGBOSS_PROXY_CORS_CREDENTIALS === 'true'
    config.cors!.maxAge = env.PGBOSS_PROXY_CORS_MAX_AGE
  }

  return config
}

export const mergeEnvConfig = (
  options: EnvConfig,
  envConfig: EnvConfig
): EnvConfig => {
  const merged = {
    prefix: options.prefix ?? envConfig.prefix,
    requestLogger: options.requestLogger ?? envConfig.requestLogger,
    logFormat: options.logFormat ?? envConfig.logFormat,
    exposeErrors: options.exposeErrors ?? envConfig.exposeErrors,
    bodyLimit: options.bodyLimit ?? envConfig.bodyLimit,
    routes: {
      allow: options.routes?.allow ?? envConfig.routes?.allow,
      deny: options.routes?.deny ?? envConfig.routes?.deny
    },
    pages: {
      root: options.pages?.root ?? envConfig.pages?.root,
      docs: options.pages?.docs ?? envConfig.pages?.docs,
      openapi: options.pages?.openapi ?? envConfig.pages?.openapi
    },
    auth: {
      username: options.auth?.username ?? envConfig.auth?.username,
      password: options.auth?.password ?? envConfig.auth?.password
    },
    cors: {
      origin: options.cors?.origin ?? envConfig.cors?.origin,
      methods: options.cors?.methods ?? envConfig.cors?.methods,
      headers: options.cors?.headers ?? envConfig.cors?.headers,
      exposeHeaders: options.cors?.exposeHeaders ?? envConfig.cors?.exposeHeaders,
      credentials: options.cors?.credentials ?? envConfig.cors?.credentials,
      maxAge: options.cors?.maxAge ?? envConfig.cors?.maxAge
    }
  }

  validateRoutes(merged.routes?.allow, merged.routes?.deny)

  return merged
}

export const configureLogging = async (logFormat: LogFormat | undefined): Promise<void> => {
  if (logFormat === 'json') {
    await configure({
      sinks: { console: getConsoleSink() },
      loggers: [
        { category: ['pg-boss', 'proxy'], lowestLevel: 'info', sinks: ['console'] },
        { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] }
      ]
    })
    const logger = getLogger(['pg-boss', 'proxy'])
    logger.info('JSON logging enabled - configure LogTape manually for custom JSON formatting')
  }
}

export const setupBasicLogging = (): void => {
  try {
    getLogger(['pg-boss', 'proxy'])
  } catch {
    configure({
      sinks: { console: getConsoleSink() },
      loggers: [
        { category: ['pg-boss', 'proxy'], lowestLevel: 'info', sinks: ['console'] },
        { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] }
      ]
    }).catch(() => {})
  }
}

export const configureAuth = (app: OpenAPIHono, auth: AuthConfig | undefined, prefix: string): void => {
  const username = auth?.username
  const password = auth?.password

  if (username && !password) {
    throw new Error('PGBOSS_PROXY_AUTH_PASSWORD is required when PGBOSS_PROXY_AUTH_USERNAME is set')
  }

  if (!username && password) {
    throw new Error('PGBOSS_PROXY_AUTH_USERNAME is required when PGBOSS_PROXY_AUTH_PASSWORD is set')
  }

  if (username && password) {
    app.use(`${prefix}/*`, basicAuth({ username, password }))
  }
}

export const configureCors = (app: OpenAPIHono, corsConfig: CorsConfig | undefined, prefix: string): void => {
  const origin = corsConfig?.origin

  if (!origin) {
    return
  }

  const origins = origin.split(',').map((o) => o.trim())

  const options: Parameters<typeof cors>[0] = {
    origin: origins.length === 1 && origins[0] === '*' ? '*' : origins,
    allowMethods: corsConfig.methods?.split(',').map((m) => m.trim()) ?? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: corsConfig.headers?.split(',').map((h) => h.trim()) ?? ['Content-Type', 'Authorization'],
    exposeHeaders: corsConfig.exposeHeaders?.split(',').map((h) => h.trim()) ?? [],
    credentials: corsConfig.credentials ?? false,
    maxAge: corsConfig.maxAge ? parseInt(corsConfig.maxAge, 10) : undefined
  }

  app.use(`${prefix}/*`, cors(options))
}

export type { EnvConfig, AuthConfig, CorsConfig }
