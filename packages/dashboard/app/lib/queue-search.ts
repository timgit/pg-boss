import { useEffect } from 'react'
import { useFetcher, useSearchParams } from 'react-router'
import { resolveDbHref } from '~/components/db-link'
import type { QueueNamesResult } from '~/routes/queue-names'
import { term } from './terms'

export interface QueueSearch {
  /** The first names containing the search, in name order, or null before the first answer. */
  names: string[] | null
  /** More queues match than `names` holds. */
  more: boolean
}

/**
 * The queue names containing `search`, asked of the server while `open`: at once with an empty
 * search, then 150ms after typing stops, so each key is not a request.
 */
export function useQueueSearch (open: boolean, search: string): QueueSearch {
  const [searchParams] = useSearchParams()
  const fetcher = useFetcher<QueueNamesResult>()
  const q = search.trim()
  const href = open ? resolveDbHref(`/queue-names?${new URLSearchParams({ q })}`, searchParams.get(term.param)) : null

  useEffect(() => {
    if (!href) return
    const timer = setTimeout(() => fetcher.load(href), q ? 150 : 0)
    return () => clearTimeout(timer)
    // `fetcher` is a new object each render; the request depends only on the URL.
  }, [href])

  return { names: fetcher.data?.names ?? null, more: fetcher.data?.more ?? false }
}
