import { serve } from '@hono/node-server'
import type { ConstructorOptions } from 'pg-boss'
import {
  attachShutdownListeners,
  createProxyApp,
  createProxyService,
  nodeShutdownAdapter,
  type ProxyApp,
  type ProxyOptions,
  type ProxyService
} from './index.js'

type ProxyNodeOptions = Omit<ProxyOptions, 'options'> & {
  connectionString?: string
  options?: ConstructorOptions
}

type ProxyServerNodeOptions = ProxyNodeOptions & {
  port?: number
  hostname?: string
  shutdownSignals?: NodeJS.Signals[]
  attachSignals?: boolean
  onListen?: (info: { port: number }) => void
}

type ProxyServerNode = Omit<ProxyService, 'start' | 'stop'> & {
  hostname: string
  port: number
  server: ReturnType<typeof serve> | null
  start: () => Promise<{ port: number }>
  stop: () => Promise<void>
  detachSignals?: () => void
}

const resolveOptions = (options: ProxyNodeOptions): ConstructorOptions => {
  if (options.connectionString && options.options) {
    throw new Error('Provide either connectionString or options, not both.')
  }

  if (options.connectionString) {
    return { connectionString: options.connectionString }
  }

  if (options.options) {
    return options.options
  }

  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL }
  }

  throw new Error('Proxy requires PgBoss constructor options or DATABASE_URL.')
}

export const createProxyAppNode = (options: ProxyNodeOptions = {}): ProxyApp => {
  const { connectionString: _, options: __, ...rest } = options
  return createProxyApp({ ...rest, options: resolveOptions(options) })
}

export const createProxyServiceNode = (options: ProxyNodeOptions = {}): ProxyService => {
  const { connectionString: _, options: __, ...rest } = options
  return createProxyService({ ...rest, options: resolveOptions(options) })
}

export const createProxyServerNode = (options: ProxyServerNodeOptions = {}): ProxyServerNode => {
  const { connectionString: _, options: __, ...rest } = options
  const service = createProxyService({ ...rest, options: resolveOptions(options) })
  const hostname = options.hostname ?? process.env.HOST ?? 'localhost'
  const port = options.port ?? Number(process.env.PORT ?? 3000)
  const signals = options.shutdownSignals ?? ['SIGINT', 'SIGTERM']

  let server: ReturnType<typeof serve> | null = null
  let detachSignals: (() => void) | undefined

  const proxy = {} as ProxyServerNode

  const stop = async () => {
    try {
      await service.stop()
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server?.close(() => resolve()))
        server = null
        proxy.server = null
      }
      if (detachSignals) {
        detachSignals()
        detachSignals = undefined
        proxy.detachSignals = undefined
      }
    }
  }

  const start = async () => {
    await service.start()
    if (!server) {
      const info = await new Promise<{ port: number }>((resolve) => {
        server = serve(
          {
            fetch: service.app.fetch,
            port,
            hostname
          },
          resolve
        )
      })
      proxy.server = server
      options.onListen?.(info)
    }
    if (options.attachSignals ?? true) {
      detachSignals = attachShutdownListeners(signals, nodeShutdownAdapter, stop)
      proxy.detachSignals = detachSignals
    }
    return { port }
  }

  Object.assign(proxy, {
    ...service,
    hostname,
    port,
    server,
    start,
    stop,
    detachSignals
  })

  return proxy
}

export type { ProxyNodeOptions, ProxyServerNodeOptions, ProxyServerNode }
