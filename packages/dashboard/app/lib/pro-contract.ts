import type { ComponentType, ReactNode } from 'react'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { RouterContextProvider } from 'react-router'
import type { Instance, QueueThroughputPoint } from '~/lib/types'
import type { LatencySummary, StatsInterval } from '~/lib/stats'

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
export type ActionPage = 'overview' | 'jobs' | 'queues' | 'schedules'

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
 * One queue's throughput as a /stats page already holds it: every bucket of the previous window
 * then the current one, the two halves equal in length, empty buckets as nulls.
 */
export interface StatsQueueSeries {
  name: string
  interval: StatsInterval
  /** The width of each point, in seconds. */
  bucketSeconds: number
  /** On `/stats/:queue` each point also carries its bucket's wait and run histograms; on a tile it does not. */
  points: QueueThroughputPoint[]
  /** Wait and run times summed per window, and the oldest ready wait. Null before pg-boss 12.36. */
  latency: LatencySummary | null
}

/** What `/stats/:queue` tells `statsQueueKpi`: the queue at the page's own resolution. */
export interface StatsQueueKpiProps {
  queue: StatsQueueSeries
}

/** What `/stats` tells `statsOverviewKpi`: every queue, at its tile's resolution. */
export interface StatsOverviewKpiProps {
  queues: StatsQueueSeries[]
}

/** How a tile stands: its border, its place in the overlay's order, and a badge beside its name. */
export interface StatsTileAssessment {
  /** A red border for critical, amber for watch, none for null. */
  severity: 'critical' | 'watch' | null
  /** Lower comes first in the overlay's order; ties go busiest first. */
  rank: number
  badge?: ReactNode
  /** A line under the tile's chart, such as a figure the free tile does not show. */
  line?: ReactNode
}

/**
 * The overlay's part in the `/stats` tiles. Not a component: a tile's border and the grid's order
 * are the grid's own, so the overlay says how each queue stands and the grid draws it.
 */
export interface StatsTileSlot {
  /**
   * A React hook the grid calls on every render with every queue's tile series, so the overlay can
   * load what it needs once for all of them. Returns how each queue stands, by name; a queue left
   * out gets no badge, no border and the last place in the overlay's order.
   */
  useAssessments: (queues: StatsQueueSeries[]) => ReadonlyMap<string, StatsTileAssessment>
  /** The name of the order `rank` gives, offered beside "Busiest first" and chosen by default. */
  sortLabel?: string
}

/** What `/stats/:queue` tells `statsQueuePanels`: the queue, and the axis and cursor its charts share. */
export interface StatsQueuePanelsProps {
  queue: StatsQueueSeries
  /** Unix seconds at the left and right edges of the page's charts. */
  range: [number, number]
  /** Charts given this key move one cursor with the page's own. */
  syncKey: string
  /** "hour", "6 hours", "24 hours". */
  noun: string
}

/** What a `/stats` chart tells `statsChartMarkers` about the axis the row sits under. */
export interface StatsChartMarkersProps {
  /** Null on the all-queues chart. */
  queue: string | null
  chart: 'throughput' | 'depth'
  /** Unix seconds at the left and right edges of the plot. */
  from: number
  to: number
  /** The chart's bucket width in seconds: changes inside one bucket are one point on the chart. */
  bucketSeconds: number
  /** Where the plot sits across the chart, in CSS pixels, so a marker at time t lines up with the axis. */
  plot: { left: number, width: number }
}

/** What `/instances` tells `instancesOverview`: every registered instance, read at `checkedOn`. */
export interface InstancesOverviewProps {
  /** Every row in the registry, live, quiet and stopped, whatever the list is filtered to. */
  instances: Instance[]
  /** The database's clock when the rows were read. Judge ages against it, not the browser's. */
  checkedOn: Date
}

/** One instance in the `/instances` list. */
export interface InstanceSlotProps {
  instance: Instance
  checkedOn: Date
}

/** How an instance stands in the list: its row's stripe, its place in the overlay's order, and its version. */
export interface InstanceAssessment {
  /** A red stripe for critical, amber for watch, none for null. */
  severity: 'critical' | 'watch' | null
  /** Lower comes first in the overlay's order; ties go by name. */
  rank: number
  /** Draw the version as out of step with the rest of the live instances. */
  flagVersion?: boolean
}

/** A column the overlay adds to the `/instances` list, after Works. */
export interface InstanceColumn {
  header: string
  align?: 'left' | 'right'
  Cell: ComponentType<InstanceSlotProps>
}

/**
 * The overlay's part in the `/instances` list. Not a component: the rows, their order and their
 * filter are the list's own, so the overlay says how each instance stands and what else to show.
 */
export interface InstancesListSlot {
  /**
   * A React hook the list calls on every render with every registered instance. Returns how each
   * stands, by id; one left out gets no stripe and the last place in the overlay's order.
   */
  useAssessments?: (instances: Instance[], checkedOn: Date) => ReadonlyMap<string, InstanceAssessment>
  /** The name of the order `rank` gives, offered beside "By name" and chosen by default. */
  sortLabel?: string
  columns?: InstanceColumn[]
  /** Opens under a row when its name is pressed. */
  Detail?: ComponentType<InstanceSlotProps>
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

  /**
   * Cards after the two rates in the `/stats/:queue` key figures, in a cell about as wide as two and
   * a half rate cards, room for two. Given the series the page loaded, so the common case needs no
   * request of its own.
   */
  statsQueueKpi?: ComponentType<StatsQueueKpiProps>

  /** Panels under the depth chart on `/stats/:queue`, on the page's time axis and cursor. */
  statsQueuePanels?: ComponentType<StatsQueuePanelsProps>

  /** A third card in the `/stats` key figures, given every queue's tile series. */
  statsOverviewKpi?: ComponentType<StatsOverviewKpiProps>

  /** A badge, a border and an order for the `/stats` tiles. */
  statsQueueTile?: StatsTileSlot

  /** A row under a `/stats` chart's time axis, lined up with the plot. */
  statsChartMarkers?: ComponentType<StatsChartMarkersProps>

  /** Above the `/instances` list, given every registered instance. */
  instancesOverview?: ComponentType<InstancesOverviewProps>

  /** Columns, a stripe, an order and a row detail for the `/instances` list. */
  instancesList?: InstancesListSlot
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
