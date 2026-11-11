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

/**
 * Apply the overlay's names for the dashboard's settings: each alias that is set takes the place
 * of the dashboard's name in the environment. Called by every entry before it reads a setting. A
 * free build declares no aliases, so this changes nothing there.
 */
export function applySettingAliases (overlay: ProServerOverlay, env: NodeJS.ProcessEnv = process.env): void {
  for (const [alias, name] of Object.entries(overlay.settingAliases ?? {})) {
    const value = env[alias]

    if (value === undefined || value === '') continue

    if (env[name] && env[name] !== value) {
      console.warn(`${alias} and ${name} are both set, to different values. Using ${alias}.`)
    }

    env[name] = value
  }
}
