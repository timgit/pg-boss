import { serve } from '@hono/node-server'
import { attachShutdownListeners } from './index.js'
import { createProxyServiceNode } from './node.js'

const { app, start, stop } = createProxyServiceNode()

await start()

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? 'localhost'

const server = serve({
  fetch: app.fetch,
  port,
  hostname
})

const shutdown = async () => {
  try {
    await stop()
  } finally {
    server.close(() => process.exit(0))
  }
}

attachShutdownListeners(['SIGINT', 'SIGTERM'], process, shutdown)

console.log(`pg-boss proxy listening on http://${hostname}:${port}`)
