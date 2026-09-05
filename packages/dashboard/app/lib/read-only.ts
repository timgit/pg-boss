import { useRouteLoaderData } from 'react-router'

/**
 * Whether the dashboard is in read-only mode, as published by the root loader.
 *
 * The server refuses mutations on its own (see `read-only.server.ts`), so this only
 * decides whether a control is drawn. A missing or stale value can never grant a
 * right — at worst it renders a button whose submit then returns 403.
 */
export function useReadOnly (): boolean {
  const data = useRouteLoaderData('root') as { readOnly?: boolean } | undefined
  return data?.readOnly === true
}
