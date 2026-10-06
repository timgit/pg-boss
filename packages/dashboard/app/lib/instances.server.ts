import { getInstanceRegistry } from './queries.server'
import type { Instance } from './types'

/** What `/instances` shows: every registered instance, read at the database's `checkedOn`. */
export type InstancesData = Awaited<ReturnType<typeof getInstanceRegistry>>

/**
 * The registry for `/instances`. Apart from the route so an overlay that replaces the page can load
 * it too.
 */
export async function loadInstances (DB_URL: string, SCHEMA: string): Promise<InstancesData> {
  return getInstanceRegistry(DB_URL, SCHEMA)
}

export interface InstancePageData {
  instance: Instance
  /** Every registered instance, for an overlay that reads one row against the rest. */
  instances: Instance[]
  checkedOn: Date
}

/**
 * One registered instance by id, for `/instances/:id`. Throws a 404 response when there is no
 * such row, or the schema predates the registry.
 */
export async function loadInstancePage (DB_URL: string, SCHEMA: string, id: string): Promise<InstancePageData> {
  const { available, instances, checkedOn } = await getInstanceRegistry(DB_URL, SCHEMA)
  const instance = available ? instances.find((i) => i.id === id) : undefined

  if (!instance) {
    throw new Response('Instance not found', { status: 404 })
  }

  return { instance, instances, checkedOn }
}
