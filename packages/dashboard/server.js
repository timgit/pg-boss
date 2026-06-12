// Development server. Replaces `react-router dev` so the app runs inside our own Hono
// server (auth + per-request load context) during development. Vite runs in middleware
// mode to handle module transforms, HMR, and asset serving; everything else falls
// through to the Hono app. Production uses the bundled `build/server.js` instead.
import { createServer as createHttpServer } from 'node:http'
import { createServer as createViteServer } from 'vite'
import { getRequestListener } from '@hono/node-server'

const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || 'localhost'

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'custom',
})

// Load our Hono app factory through the ssr environment's module runner
// (v8_viteEnvironmentApi) so it (and its TypeScript deps) need no separate
// compile step.
const ssrRunner = vite.environments.ssr.runner
const { createHonoApp } = await ssrRunner.import('/app/server.ts')

const app = createHonoApp({
  mode: 'development',
  serveStaticAssets: false,
  // Re-fetch the server build per request so route edits are picked up via HMR.
  build: () => ssrRunner.import('virtual:react-router/server-build'),
})

const honoListener = getRequestListener(app.fetch)

const server = createHttpServer((req, res) => {
  // Vite handles its own asset/HMR/module requests; anything it passes on goes to Hono.
  vite.middlewares(req, res, () => honoListener(req, res))
})

server.listen(port, host, () => {
  console.log(`pg-boss dashboard dev server: http://${host}:${port}`)
})
