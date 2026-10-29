import type { ServerBuild } from 'react-router'
import type { ProServerOverlay } from './pro-contract'

/**
 * The Pro overlay's server half, as `app/entry.server.tsx` exported it into this
 * build: the stub in a free build, the overlay's `server.ts` in a Pro one.
 *
 * Throws when the export is missing rather than falling back to no overlay. A
 * build without it was made from some other entry, and serving a Pro build with
 * no overlay serves every route with none of Pro's authentication.
 */
export function serverOverlayOf (build: ServerBuild): ProServerOverlay {
  const { serverOverlay } = build.entry.module as { serverOverlay?: ProServerOverlay }

  if (!serverOverlay) {
    throw new Error(
      'This server build has no serverOverlay export. It was built without ' +
      'app/entry.server.tsx, so the Pro overlay, if any, cannot be loaded.'
    )
  }

  return serverOverlay
}
