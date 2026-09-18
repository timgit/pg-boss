import { useRouteLoaderData } from 'react-router'
import { DEFAULT_DENIAL, can, type Capabilities, type Capability, type Denial } from './capabilities'

/**
 * Whether the current person may do one specific thing, as published by the root
 * loader.
 *
 * The server refuses every mutation on its own — `read-only.server.ts` here, and
 * the Pro overlay's middleware when one is mounted — so this only decides whether
 * a control is drawn. A missing or stale value can never grant a right: at worst
 * it hides a button someone was entitled to, and at no point does it let a
 * submit through that the server would have refused.
 *
 * Replaces `useReadOnly()` at every control. The boolean could not distinguish an
 * operator who may retry a job from an admin who may also delete one, and drawing
 * a Delete button that the server then refuses teaches people that the product's
 * buttons lie.
 */
export function useCan (capability: Capability): boolean {
  const data = useRouteLoaderData('root') as { can?: Capabilities } | undefined
  return can(data?.can, capability)
}

/**
 * Why a control is missing. Used by the notices that stand in for whole forms.
 *
 * Falls back to the free dashboard's wording, which names the environment
 * variable — correct there, and wrong for someone whose role simply does not
 * include the action, which is why an overlay may replace it.
 */
export function useDenial (): Denial {
  const data = useRouteLoaderData('root') as { denial?: Denial } | undefined
  return data?.denial ?? DEFAULT_DENIAL
}
