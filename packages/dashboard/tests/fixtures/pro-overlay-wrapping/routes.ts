import type { RouteConfigEntry } from '@react-router/dev/routes'
import { layout } from '@react-router/dev/routes'

/**
 * The wrapping form of an overlay route config: handed the free routes, returns
 * the whole table. A real overlay puts authorisation `middleware` on the layout
 * so every free action inherits it.
 */
export default function (freeRoutes: RouteConfigEntry[]): RouteConfigEntry[] {
  return [layout('pro/routes/guard.tsx', freeRoutes)]
}
