import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { resolveBasePath } from './app/lib/base-path'

const { viteBase } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)

export default defineConfig(({ command }) => ({
  // Vite bakes `base` into asset URLs at build time, which is what production
  // deployments behind a sub-path need. In dev we keep it at `/`: the React
  // Router dev server requires `basename` to start with `base`, and the dev
  // server serves assets from the root regardless of the app's basename.
  base: command === 'build' ? viteBase : '/',
  // The base path is a build-time concept (it is baked into asset URLs above), so
  // inline it into the bundled server too. This lets `app/server.ts` resolve the
  // basename without depending on the env var being present at runtime.
  define: {
    'process.env.PGBOSS_DASHBOARD_BASE_PATH': JSON.stringify(
      process.env.PGBOSS_DASHBOARD_BASE_PATH ?? '',
    ),
  },
  plugins: [
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    alias: {
      '~': '/app',
      'pg-boss': resolve(__dirname, '../../src'),
    },
    // Force a single copy of React in the dev module graph. Without this, Vite's
    // dependency optimizer can pre-bundle a second React instance for a dep that
    // imports it (react-router, @base-ui/react, lucide-react, …), and the two
    // instances surface at runtime as `Cannot read properties of null (reading
    // 'useContext')` — React's dispatcher is null because hooks run against a
    // different React than the one doing the render.
    dedupe: ['react', 'react-dom'],
  },
}))
