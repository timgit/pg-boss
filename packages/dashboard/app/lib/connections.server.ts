import type { Connections } from './types'

/** Runs one read and returns its rows, so a pool or a single client can serve it. */
export type ReadRows = <R>(sql: string) => Promise<R[]>

/**
 * The server's connections from `pg_stat_activity`: its `max_connections` and every client
 * connection. CockroachDB has no `max_connections`, so this rejects there.
 */
export async function readConnections (read: ReadRows): Promise<Connections> {
  const [server] = await read<{ max: number, used: number }>(
    `SELECT current_setting('max_connections')::int AS max,
            (SELECT count(*) FROM pg_stat_activity
              WHERE backend_type = 'client backend' AND pid <> pg_backend_pid())::int AS used`
  )

  return { max: server.max, used: server.used }
}
