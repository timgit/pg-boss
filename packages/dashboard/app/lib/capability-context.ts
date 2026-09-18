import { createContext, type RouterContext } from 'react-router'
import type { Capabilities, Denial } from './capabilities'

/**
 * What the Pro overlay puts in the request context to say who is asking and what
 * they may do, read by the root loader and published to the browser from there.
 *
 * Optional in every sense: a free dashboard never sets it, and the root loader
 * falls back to read-only mode's answer. An overlay sets it from `loadContext`,
 * which runs after the free dashboard has seeded the context — late enough to
 * know the actor, early enough for any loader to see the result.
 */
export interface CapabilityContext {
  capabilities: Capabilities
  /** Shown where a form would be. Omitted keeps the free dashboard's wording. */
  denial?: Denial
}

// Pinned on globalThis for the same reason `dbContext` is: production ships the
// route modules and the Hono server as two separate bundles, each of which would
// otherwise evaluate this module and mint its own token, so what the server set
// would be invisible to the loader's get. See the longer note in `db-context.ts`.
//
// The default is `null`, not `undefined`. A context with no default throws
// "No value found for context" on `get`, and passing `undefined` is
// indistinguishable from passing nothing — so a free dashboard, which never sets
// this, would crash its own root loader. `null` is a real default and reads back
// as "nobody set this".
const TOKEN_KEY = Symbol.for('pgboss.dashboard.capabilityContext')
const globalStore = globalThis as typeof globalThis & {
  [TOKEN_KEY]?: RouterContext<CapabilityContext | null>
}

export const capabilityContext: RouterContext<CapabilityContext | null> =
  globalStore[TOKEN_KEY] ??= createContext<CapabilityContext | null>(null)
