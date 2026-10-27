import type { Config } from '@react-router/dev/config'
import { resolveBasePath } from './app/lib/base-path.ts'

const { routerBasename } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)

export default {
  ssr: true,
  basename: routerBasename,
  future: {
    // Dev only. Hands every route module, the Pro overlay's included, to Vite's dependency scan
    // at server start. Without it the scan has no entries, and the first page to import a new
    // browser package reloads instead of navigating. See `optimizeDeps` in vite.config.ts.
    unstable_optimizeDeps: true,
  },
} satisfies Config
