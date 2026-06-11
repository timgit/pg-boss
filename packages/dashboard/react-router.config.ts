import type { Config } from '@react-router/dev/config'
import { resolveBasePath } from './app/lib/base-path'

const { routerBasename } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)

export default {
  ssr: true,
  basename: routerBasename,
} satisfies Config
