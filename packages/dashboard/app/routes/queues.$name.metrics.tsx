import { redirect } from 'react-router'
import type { Route } from './+types/queues.$name.metrics'
import { metricsRedirectSearch } from '~/lib/stats'

// The metrics chart moved into /stats/:queue as its depth panel. Old links and bookmarks land there,
// keeping the parts of their query that still apply.
export function loader ({ params, request }: Route.LoaderArgs) {
  const search = metricsRedirectSearch(new URL(request.url).searchParams)
  return redirect(`/stats/${encodeURIComponent(params.name)}${search}`, 301)
}
