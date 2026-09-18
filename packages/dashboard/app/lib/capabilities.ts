/**
 * What the person looking at this page is allowed to do, as the UI sees it.
 *
 * Presentation only. Every mutation is refused on the server too — by
 * `read-only.server.ts` here, and by the Pro overlay's own middleware when one
 * is mounted — so a stale or forged value in the browser can never grant a
 * right. All it decides is whether a control is drawn.
 *
 * Without an overlay this is a restatement of read-only mode: everything is
 * permitted, or nothing is. The reason it is a map rather than the boolean it
 * replaces is that roles are not a single switch. Pro's `operator` may retry and
 * cancel a job but not delete it, and a boolean cannot say that — it would draw
 * a Delete button that the server then refuses, which teaches people to expect
 * errors from buttons the product showed them.
 */

/**
 * Every mutating control the dashboard draws.
 *
 * One entry per thing a person can do, not per route: `job:delete` is one
 * capability even though two routes offer it. Adding a mutating control means
 * adding a capability here, and the overlay contract is unchanged — which is the
 * point of naming them rather than counting them.
 */
export const CAPABILITIES = [
  'job:retry',
  'job:cancel',
  'job:resume',
  'job:delete',
  'job:send',
  'queue:create',
  'schedule:create',
  'schedule:delete',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * A partial map, so an overlay compiled against an older dashboard stays valid
 * when a later one adds a capability.
 *
 * Absent means denied — see `can()`. A new control is then briefly invisible to
 * Pro users rather than briefly visible to viewers, and the release rule (a
 * dashboard tag is not done until the matching Pro build ships) keeps that
 * window short.
 */
export type Capabilities = Partial<Record<Capability, boolean>>

/** Read a capability, treating anything unset as denied. */
export function can (capabilities: Capabilities | undefined, capability: Capability): boolean {
  return capabilities?.[capability] === true
}

/**
 * What a dashboard with no overlay publishes: read-only mode inverted.
 *
 * Every capability is listed explicitly rather than defaulting, so a capability
 * added later without a thought about the free dashboard fails the type check
 * here instead of silently becoming unavailable to everyone.
 */
export function defaultCapabilities (readOnly: boolean): Capabilities {
  const allowed = !readOnly

  return {
    'job:retry': allowed,
    'job:cancel': allowed,
    'job:resume': allowed,
    'job:delete': allowed,
    'job:send': allowed,
    'queue:create': allowed,
    'schedule:create': allowed,
    'schedule:delete': allowed,
  }
}

/**
 * Why a control is missing, shown where a form would otherwise be.
 *
 * The default names the environment variable, because for a free dashboard that
 * is the whole and only answer. An overlay replaces it, since telling someone
 * whose role is `viewer` to unset a variable they did not set and cannot see
 * sends them to the wrong place entirely.
 */
export interface Denial {
  /** Heading. Short. */
  title: string
  /** One sentence naming what to do about it, if anything. */
  detail: string
}

export const DEFAULT_DENIAL: Denial = {
  title: 'This dashboard is read-only',
  detail: 'The server was started with PGBOSS_DASHBOARD_READ_ONLY=1. Unset it to restore write access.',
}
