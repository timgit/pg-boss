import type { ComponentType } from 'react'

/**
 * The contract between this package and an optional Pro overlay.
 *
 * Types only — there is never an implementation here, so the stub in
 * `pro-stub.ts` and any overlay typecheck against one source.
 *
 * The overlay has two halves, resolved by different mechanisms because React
 * Router's config loader runs outside the Vite module graph:
 *
 * - **Config-time** (`app/pro/routes.ts`) — route definitions, resolved by
 *   relative path in `pro-routes.ts`.
 * - **Runtime** (`app/pro/index.tsx`) — everything below, resolved through the
 *   `~pro` alias like any other module.
 */

export interface ProNavItem {
  name: string
  href: string
  icon: ComponentType<{ className?: string }>
}

/** Named regions of the free UI an overlay may render into. */
export interface ProSlots {
  /** Above the theme controls in the sidebar footer. */
  sidebarFooter?: ComponentType
}

export interface ProOverlay {
  nav: ProNavItem[]
  slots: ProSlots
}
