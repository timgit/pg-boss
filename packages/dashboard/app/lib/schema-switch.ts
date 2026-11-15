/**
 * Where the database switcher goes from `pathname`. A page about one item (a queue, a job, a
 * schedule) gives way to the list it belongs to, since the other database may not have that item:
 * the path is cut at its first segment that holds a route parameter, so `/queues/:name/jobs/:jobId`
 * lands on `/queues` and Pro's `/pro/alerts/:id` on `/pro/alerts`. Any other page stays put.
 */
export function switchPathname (pathname: string, params: Record<string, string | undefined>): string {
  const values = new Set(Object.values(params).filter((value): value is string => !!value))

  if (!values.size) return pathname

  const segments = pathname.split('/')

  // From 2, past the leading empty segment and the page's own name, so a queue called "queues"
  // still cuts after `/queues`.
  for (let k = 2; k < segments.length; k++) {
    if (values.has(decode(segments[k])) || values.has(segments[k])) {
      return segments.slice(0, k).join('/') || '/'
    }
  }

  return pathname
}

function decode (segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
