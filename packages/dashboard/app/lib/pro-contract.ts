import type { ComponentType } from 'react'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { RouterContextProvider } from 'react-router'

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
 * - **Runtime** (`app/pro/index.tsx`) — the React half below, resolved through
 *   the `~pro` alias like any other module.
 * - **Server** (`ProServerOverlay`) — the Hono half, loaded from a file the Pro
 *   build emits next to the server bundle. See `pro-server.ts` for why it
 *   cannot travel through the `~pro` alias with the rest.
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

/**
 * The overlay's server half: middleware, and whatever the loaders need to know
 * about who is asking.
 *
 * Kept apart from `ProOverlay` because the two are bundled by different tools
 * into different files. Everything above reaches the browser through Vite;
 * everything here runs only in the Node server esbuild produces, and must never
 * pull a React component in with it.
 */
export interface ProServerOverlay {
  /**
   * The overlay authenticates requests itself, so the free Basic-auth gate is
   * skipped rather than stacked in front of it.
   *
   * Without this an operator who sets `PGBOSS_DASHBOARD_AUTH_*` and then buys
   * Pro gets two prompts for two unrelated credentials, and the browser's Basic
   * dialog is the one they cannot log out of. The overlay owning auth is the
   * stronger statement — per-user, per-role, per-database — so it wins, and
   * `createHonoApp` says so on stdout rather than dropping a configured
   * credential silently.
   */
  ownsAuth?: boolean

  /**
   * Register middleware and routes on the Hono app, before any free middleware.
   *
   * First because the overlay's own login route has to be reachable by someone
   * who is not yet authenticated, and because middleware that establishes who
   * the actor is has to run before anything that decides what they may do.
   */
  server?: (app: Hono) => void

  /**
   * Add to the per-request load context, after the free dashboard has seeded it.
   *
   * After, so the overlay can both add its own values (the actor) and narrow
   * what the free dashboard chose (the database a viewer is allowed to see).
   * Running first would mean the free defaults silently overwrote the narrowing.
   */
  loadContext?: (c: Context, context: RouterContextProvider) => void
}
