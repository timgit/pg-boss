import { useMatches } from 'react-router'
import overlay from '~pro'
import { deepestTitle, documentTitle } from '~/lib/page-title'

const APP = overlay.title?.app ?? 'pg-boss Dashboard'

/**
 * The browser tab: the deepest page's own name first, then the app's. Rendered rather than returned
 * from `meta`, because a parent's `meta` never sees the routes below it, and React hoists the element
 * into the document head.
 */
export function DocumentTitle () {
  const matches = useMatches()
  const page = deepestTitle(matches, overlay.title?.fallback)
  return <title>{documentTitle(page, APP)}</title>
}
