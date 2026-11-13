import type { RouteConfigEntry } from '@react-router/dev/routes'
import { layout } from '@react-router/dev/routes'

/**
 * The wrapping form of an overlay route config: handed the dashboard's routes, returns
 * the whole table. A real overlay puts authorisation `middleware` on the layout
 * so every dashboard action inherits it.
 */
export default function (dashboardRoutes: RouteConfigEntry[]): RouteConfigEntry[] {
  return [layout('pro/routes/guard.tsx', dashboardRoutes)]
}
