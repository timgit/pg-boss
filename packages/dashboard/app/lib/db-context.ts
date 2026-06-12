import { createContext, type RouterContext } from 'react-router'
import type { DatabaseConfig } from './config.server'

// The per-request load context the loaders/actions rely on. With the
// `v8_middleware` future flag on, React Router exposes `context` as a
// RouterContextProvider, read via `context.get(dbContext)` instead of plain
// property access. Seeded by `getLoadContext` in `app/server.ts`.
export interface DbContext {
  readonly databases: DatabaseConfig[]
  readonly currentDb: DatabaseConfig
  readonly DB_URL: string
  readonly SCHEMA: string
}

// `createContext()` returns an identity-keyed token: a RouterContextProvider stores
// values in a Map keyed by this exact object. In production the dashboard ships as two
// separate bundles — `react-router build` emits the route modules (build/server/index.js)
// while esbuild bundles the Hono server that seeds the context (build/server.js). Each
// bundle would otherwise evaluate this module independently and mint its own token, so
// the value the server `set`s would be invisible to the loader's `get`. Pin a single
// token on globalThis (a process-wide Symbol.for key) so both bundles share one. In dev
// everything loads through a single Vite module graph, making this a harmless no-op.
const TOKEN_KEY = Symbol.for('pgboss.dashboard.dbContext')
const globalStore = globalThis as typeof globalThis & {
  [TOKEN_KEY]?: RouterContext<DbContext>
}

export const dbContext: RouterContext<DbContext> =
  globalStore[TOKEN_KEY] ??= createContext<DbContext>()
