import overlay from '~pro'
import type { ProSlots } from '~/lib/pro-contract'

/**
 * Renders an overlay slot, or nothing when no overlay is present. Keep
 * `ProSlots` to the regions a feature actually needs — add one when a feature
 * demands it, never speculatively.
 */
export function ProSlot ({ name }: { name: keyof ProSlots }) {
  const Component = overlay.slots[name]
  return Component ? <Component /> : null
}
