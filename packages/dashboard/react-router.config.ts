import type { Config } from '@react-router/dev/config'
import { resolveBasePath } from './app/lib/base-path'

const { routerBasename } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)

export default {
  ssr: true,
  basename: routerBasename,
  // Opt into the React Router v8 defaults early to silence the dev/build
  // "Future Flag Warning" console noise.
  //   - v8_middleware: loaders/actions receive `context` as a
  //     RouterContextProvider, seeded by getLoadContext in app/server.ts and read
  //     via context.get(dbContext) (see app/lib/db-context.ts). This unlocks
  //     React Router's native per-route `middleware` exports for any future
  //     cross-cutting logic.
  //   - v8_viteEnvironmentApi: builds the app through Vite's Environment API
  //     (stabilized in @react-router/dev 7.17). The dev server (server.js) loads
  //     SSR modules via the ssr environment's module runner.
  future: {
    v8_splitRouteModules: true,
    v8_passThroughRequests: true,
    v8_trailingSlashAwareDataRequests: true,
    v8_middleware: true,
    v8_viteEnvironmentApi: true,
  },
} satisfies Config
