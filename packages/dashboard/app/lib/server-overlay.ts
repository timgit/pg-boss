import type { ServerBuild } from 'react-router'
import type { ProServerOverlay } from './pro-contract'

/**
 * The Pro overlay's server half, as `app/entry.server.tsx` exported it into this
 * build: the stub in a build without Pro, the overlay's `server.ts` in a Pro one.
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

/**
 * Apply the overlay's names for the dashboard's settings: each one replaces the dashboard's name,
 * which then reads the overlay's value or nothing. A value set under the dashboard's own name is
 * dropped, so each setting has one name. Called by every entry before it reads a
 * setting. This changes nothing in a build without Pro, which declares no aliases.
 */
export function applySettingAliases (overlay: ProServerOverlay, env: NodeJS.ProcessEnv = process.env): void {
  for (const [alias, name] of Object.entries(overlay.settingAliases ?? {})) {
    const value = env[alias] || undefined

    if (value === undefined) delete env[name]
    else env[name] = value
  }
}
