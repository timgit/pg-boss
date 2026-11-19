import { PassThrough } from 'node:stream'
import type { EntryContext, RouterContextProvider } from 'react-router'
import { createReadableStreamFromReadable } from '@react-router/node'
import { ServerRouter } from 'react-router'
import { isbot } from 'isbot'
import type { RenderToPipeableStreamOptions } from 'react-dom/server'
import { renderToPipeableStream } from 'react-dom/server'
import { cspNonceContext } from '~/lib/csp-nonce'
import { CspNonce } from '~/components/csp-nonce'

/**
 * React Router's default Node entry, plus one export: the Pro overlay's server
 * half, which the servers read from `build.entry.module` through
 * `serverOverlayOf()`.
 *
 * Exported from here so the overlay's Hono hook runs in the same module graph as
 * the routes: Vite's in dev, `build/server/index.js` in production. A module the
 * hook and a route both import is then one instance, not one per bundle.
 */
export { serverOverlay } from '~pro-server'

export const streamTimeout = 5_000

export default function handleRequest (
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    })
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false
    const userAgent = request.headers.get('user-agent')

    // Bots and SPA mode renders wait for all content before responding.
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? 'onAllReady'
        : 'onShellReady'

    // Abort after `streamTimeout`, leaving time to flush the rejected boundaries.
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000
    )

    // Set by a server hook that sends a script CSP. Each inline script React and React Router write
    // carries it, and so does the theme script in root.tsx.
    const nonce = loadContext.get(cspNonceContext) ?? undefined

    const { pipe, abort } = renderToPipeableStream(
      <CspNonce.Provider value={nonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
      </CspNonce.Provider>,
      {
        nonce,
        [readyOption] () {
          shellRendered = true
          const body = new PassThrough({
            final (callback) {
              clearTimeout(timeoutId)
              timeoutId = undefined
              callback()
            },
          })
          const stream = createReadableStreamFromReadable(body)

          responseHeaders.set('Content-Type', 'text/html')

          pipe(body)

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          )
        },
        onShellError (error: unknown) {
          reject(error)
        },
        onError (error: unknown) {
          responseStatusCode = 500
          // Errors in the initial shell reject and are logged by React Router.
          if (shellRendered) {
            console.error(error)
          }
        },
      }
    )
  })
}
