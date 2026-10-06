import type { ComponentProps, ComponentType } from 'react'
import overlay from '~pro'
import type { InstancesListSlot, ProSlots } from '~/lib/pro-contract'

/** The slots that are a component to render, rather than an object a page reads. */
type ComponentSlot = {
  [K in keyof ProSlots]-?: NonNullable<ProSlots[K]> extends InstancesListSlot ? never : K
}[keyof ProSlots]

/** A slot's name with the props its component takes. */
type ProSlotProps = {
  [K in ComponentSlot]: { name: K } & ComponentProps<NonNullable<ProSlots[K]>>
}[ComponentSlot]

/**
 * Renders an overlay slot, or nothing when no overlay is present. Keep
 * `ProSlots` to the regions a feature actually needs — add one when a feature
 * demands it, never speculatively.
 */
export function ProSlot ({ name, ...props }: ProSlotProps) {
  const Component = overlay.slots[name] as ComponentType<object> | undefined
  return Component ? <Component {...props} /> : null
}

/** Whether an overlay fills a slot, for layout that only exists around one, such as a table's actions column. */
export function hasProSlot (name: keyof ProSlots): boolean {
  return overlay.slots[name] !== undefined
}
