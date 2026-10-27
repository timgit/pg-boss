/** `PGBOSS_DASHBOARD_TRUST_PROXY=1`: read the request's public origin from the proxy's headers. */
export function isTrustProxy (): boolean {
  return process.env.PGBOSS_DASHBOARD_TRUST_PROXY === '1'
}

// `host` or `host:port`, where the host is a name, an IPv4 address or a bracketed IPv6 address.
const FORWARDED_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

// The first entry, as Express reads it: the proxy facing the browser writes it.
function firstValue (header: string | null): string | undefined {
  return header?.split(',')[0]?.trim() || undefined
}

/**
 * Rebuild the request URL from `X-Forwarded-Proto` and `X-Forwarded-Host`, so React Router's
 * origin check, redirects and the overlay see the URL the browser used. A missing or malformed
 * header keeps that part of the URL. Use only behind a proxy: anyone can send these headers.
 */
export function forwardedRequest (request: Request): Request {
  const url = new URL(request.url)
  const proto = firstValue(request.headers.get('x-forwarded-proto'))?.toLowerCase()
  const host = firstValue(request.headers.get('x-forwarded-host'))
  const scheme = proto === 'http' || proto === 'https' ? proto : url.protocol.slice(0, -1)
  const withHost = (h: string) => {
    // The pattern rejects paths and credentials; `URL.parse` still rejects a port or IP out of range.
    const target = URL.parse(`${scheme}://${h}`)

    // Set, not resolved against the origin: a path like `//evil.example.net/` would replace the host.
    if (target) {
      target.pathname = url.pathname
      target.search = url.search
    }

    return target
  }
  const publicUrl = (host && FORWARDED_HOST.test(host) && withHost(host)) || withHost(url.host) || url

  return publicUrl.href === url.href ? request : new Request(publicUrl, request)
}
