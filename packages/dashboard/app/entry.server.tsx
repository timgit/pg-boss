import { renderToReadableStream } from 'react-dom/server'
import type { AppLoadContext, EntryContext } from 'react-router'
import { ServerRouter } from 'react-router'

/**
 * Custom entry server using `renderToReadableStream` (Web Streams) instead of
 * the default `renderToPipeableStream` (Node.js streams). This makes the
 * dashboard compatible with Bun, which ships a `react-dom/server` build that
 * omits `renderToPipeableStream`, while still working correctly on Node.js 18+
 * (which supports the Web Streams API and the `Response` constructor natively).
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        console.error(error)
        responseStatusCode = 500
      },
    },
  )

  responseHeaders.set('Content-Type', 'text/html')
  return new Response(stream, { headers: responseHeaders, status: responseStatusCode })
}
