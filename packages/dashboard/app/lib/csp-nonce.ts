import { createContext, type RouterContext } from 'react-router'

/**
 * The nonce a server hook puts on each request for its `Content-Security-Policy`, which the
 * document's inline and module scripts carry. Null by default: the dashboard sends no script CSP
 * of its own, and a page rendered without a nonce is the same page as before.
 *
 * Pinned on globalThis for the reason `schemaContext` is: the Hono server and the route modules are
 * separate bundles in production, and each needs the same token.
 */
const TOKEN_KEY = Symbol.for('pgboss.dashboard.cspNonceContext')
const globalStore = globalThis as typeof globalThis & {
  [TOKEN_KEY]?: RouterContext<string | null>
}

export const cspNonceContext: RouterContext<string | null> =
  globalStore[TOKEN_KEY] ??= createContext<string | null>(null)
