import { serve } from '@hono/node-server'
import { attachShutdownListeners } from './index.js'
import { createProxyServiceNode } from './node.js'

const { app, start, stop } = createProxyServiceNode()

try {
  await start()
} catch (err) {
  console.error('Failed to start pg-boss:', err instanceof Error ? err.message : err)
  process.exit(1)
}

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? 'localhost'

const server = serve({
  fetch: app.fetch,
  port,
  hostname
}, (info) => {
  console.log(`pg-boss proxy listening on http://${hostname}:${info.port}`)
})

const shutdown = async () => {
  try {
    await stop()
  } finally {
    server.close(() => process.exit(0))
  }
}

attachShutdownListeners(['SIGINT', 'SIGTERM'], process, shutdown)
