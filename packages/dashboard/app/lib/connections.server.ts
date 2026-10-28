import type { Backends, Connections } from './types'

/** Runs one read and returns its rows, so a pool or a single client can serve it. */
export type ReadRows = <R>(sql: string) => Promise<R[]>

/**
 * The server's connections from `pg_stat_activity`: its `max_connections`, every client connection,
 * and pg-boss's by `application_name`. A login without `pg_read_all_stats` sees other users'
 * sessions without their state, so the counts by state can read low while the totals stay right.
 * CockroachDB has no `max_connections`, so this rejects there.
 */
export async function readConnections (read: ReadRows): Promise<Connections> {
  const [server] = await read<{ max: number, used: number }>(
    `SELECT current_setting('max_connections')::int AS max,
            (SELECT count(*) FROM pg_stat_activity
              WHERE backend_type = 'client backend' AND pid <> pg_backend_pid())::int AS used`
  )
  const rows = await read<{
    application_name: string
    total: number
    active: number
    idle: number
    idle_tx: number
    oldest_tx: number | null
  }>(
    `SELECT application_name,
            count(*)::int AS total,
            count(*) FILTER (WHERE state = 'active')::int AS active,
            count(*) FILTER (WHERE state = 'idle')::int AS idle,
            count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_tx,
            extract(epoch FROM max(now() - state_change) FILTER (WHERE state LIKE 'idle in transaction%'))::float8 AS oldest_tx
       FROM pg_stat_activity
      WHERE application_name LIKE 'pgboss%' AND pid <> pg_backend_pid()
      GROUP BY application_name`
  )

  const byApp: Record<string, Backends> = {}
  for (const row of rows) {
    byApp[row.application_name] = {
      total: row.total,
      active: row.active,
      idle: row.idle,
      idleInTransaction: row.idle_tx,
      oldestIdleInTransactionSeconds: row.oldest_tx,
    }
  }

  return { max: server.max, used: server.used, byApp }
}
