import { getInstanceRegistry } from './queries.server'
import { readConnections } from './connections.server'
import { query } from './db.server'
import type { Connections, Instance } from './types'

/** What `/instances` shows: every registered instance, read at the database's `checkedOn`, and the server's connections. */
export type InstancesData = Awaited<ReturnType<typeof getInstanceRegistry>> & {
  /** Null where `pg_stat_activity` cannot be read, or the schema predates the registry. */
  connections: Connections | null
}

/**
 * The registry and the server's connections for `/instances`. Apart from the route so an overlay that
 * replaces the page can load it too.
 */
export async function loadInstances (DB_URL: string, SCHEMA: string): Promise<InstancesData> {
  const registry = await getInstanceRegistry(DB_URL, SCHEMA)
  const connections = registry.available ? await readConnections((sql) => query(DB_URL, sql)).catch(() => null) : null
  return { ...registry, connections }
}

export interface InstancePageData {
  instance: Instance
  /** Every registered instance, for an overlay that reads one row against the rest. */
  instances: Instance[]
  checkedOn: Date
  /** The server's connections now; null where `pg_stat_activity` cannot be read. */
  connections: Connections | null
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

  const connections = await readConnections((sql) => query(DB_URL, sql)).catch(() => null)

  return { instance, instances, checkedOn, connections }
}
