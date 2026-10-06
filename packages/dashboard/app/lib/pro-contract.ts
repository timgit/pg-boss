import type { ComponentType } from 'react'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { RouterContextProvider } from 'react-router'
import type { TitleMatch } from '~/lib/page-title'

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

/** What the queue page tells the slot in its header about the queue on screen. */
export interface QueueSlotProps {
  queue: {
    name: string
    /** At least one queue names this one as its `deadLetter`. */
    isDeadLetter: boolean
  }
}

/** The pages whose header carries a `pageActions` slot. */
export type ActionPage = 'overview' | 'jobs' | 'queues' | 'schedules' | 'subscriptions'

/** What a page header tells `pageActions` about where it is. */
export interface PageSlotProps {
  page: ActionPage
}

/** One job, as the job page and each row of the queue page know it. */
export interface JobSlotProps {
  job: {
    id: string
    /** The queue the job is in. */
    name: string
    state: string
  }
}

/** One schedule, as its page knows it. */
export interface ScheduleSlotProps {
  schedule: {
    name: string
    /** Null for the queue's default schedule. */
    key: string | null
  }
}

/**
 * Named regions of the free UI an overlay may render into.
 *
 * This package makes no changes of its own: every button that sends, retries,
 * creates or deletes something is an overlay's, drawn into one of these.
 */
export interface ProSlots {
  /** Above the theme controls in the sidebar footer. */
  sidebarFooter?: ComponentType

  /**
   * In the topbar, immediately after this package's own breadcrumbs.
   *
   * For a trail over routes this package does not know about. `Breadcrumbs`
   * builds its own from a fixed list of paths — queues, schedules, jobs — and
   * renders nothing for anything else, so an overlay's pages have an empty
   * topbar and no way back short of the sidebar. Rendering into this slot puts
   * an overlay's trail where every other trail in the product already is, and
   * in the server-rendered HTML rather than a frame later.
   *
   * The two never collide: a path this package recognises is one no overlay
   * owns, and a slot component that has nothing to say for the current route
   * returns null.
   */
  topbarStart?: ComponentType

  /**
   * In the topbar, at the far right, after the theme toggle.
   *
   * For controls that belong to the viewer rather than the page, such as
   * notifications and an account menu; render several as one component. It
   * shares the row with the phone-width wordmark, so keep them compact.
   */
  topbarEnd?: ComponentType

  /**
   * In a queue page's header, before this package's own buttons.
   *
   * For actions on the queue on screen, such as moving what waits in a dead
   * letter queue back into work. The component is told which queue, and
   * whether it is a dead letter queue, so it can offer only what applies
   * without a request of its own.
   */
  queueActions?: ComponentType<QueueSlotProps>

  /** In the header of the overview, jobs, queues and schedules pages, for actions that start there. */
  pageActions?: ComponentType<PageSlotProps>

  /** In a job page's header, for actions on that job. */
  jobActions?: ComponentType<JobSlotProps>

  /** At the end of each row in a queue page's jobs table, for actions on that job. */
  jobRowActions?: ComponentType<JobSlotProps>

  /** In a schedule page's header, for actions on that schedule. */
  scheduleActions?: ComponentType<ScheduleSlotProps>
}

export interface ProOverlay {
  nav: ProNavItem[]
  slots: ProSlots
  /** The app's name after each page's in the browser tab, and a name for a page that sets no `handle.title`. */
  title?: {
    app: string
    fallback?: (match: TitleMatch) => string | null
  }
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
