import { serve } from '@hono/node-server'
import {
  attachShutdownListeners,
  createProxyService,
  nodeShutdownAdapter,
  type ProxyOptions,
  type ProxyService
} from './index.js'

type ProxyNodeOptions = ProxyOptions & {
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

export async function createProxyServerNode (options: ProxyNodeOptions = {}): Promise<ProxyServerNode> {
  const service = await createProxyService(options)
  const { hostname, port } = service.config as { hostname: string; port: number }
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

export type { ProxyNodeOptions, ProxyServerNode }
