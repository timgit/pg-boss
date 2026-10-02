# Instance table

Each pg-boss instance records itself here unless it was constructed with `registerInstance: false`: at `start()`, on every heartbeat, and at `stop()`. [`getInstances()`](../api/ops.md#getinstances) reads it.

```sql
CREATE TABLE pgboss.instance (
  id uuid PRIMARY KEY,
  name text,
  host text NOT NULL,
  pid int NOT NULL,
  version text NOT NULL,
  node_version text NOT NULL,
  application_name text,
  heartbeat_seconds int NOT NULL,
  supervise bool NOT NULL,
  schedule bool NOT NULL,
  migrate bool NOT NULL,
  persist_queue_stats bool NOT NULL,
  persist_warnings bool NOT NULL,
  pool_max int,
  pool_total int,
  pool_idle int,
  pool_waiting int,
  workers jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  crash_restarts int NOT NULL DEFAULT 0,
  crash_restarts_since timestamptz,
  started_on timestamptz NOT NULL DEFAULT now(),
  heartbeat_on timestamptz NOT NULL DEFAULT now(),
  stopped_on timestamptz
)
```

| Column | Description |
|--------|-------------|
| `id` | Made when the `PgBoss` object is constructed, kept across `stop()` and `start()` |
| `name` | The `instanceName` option |
| `host`, `pid` | Where it runs |
| `version`, `node_version` | pg-boss and Node.js versions |
| `application_name` | The `application_name` its connections carry, `pgboss:` and the first 8 characters of `id` unless set otherwise |
| `heartbeat_seconds` | Its heartbeat interval, so each row can be judged quiet on its own |
| `supervise` … `persist_warnings` | Its constructor options |
| `pool_max` … `pool_waiting` | Its connection pool at the last heartbeat. Null for a `db` adapter |
| `workers` | One entry per `work()` call at the last heartbeat |
| `metrics` | Its process's CPU, memory and event loop at the last heartbeat, against its container's limits. Null until the first sample lands |
| `config` | The options it runs with, for comparing instances. Connection settings and credentials are never recorded |
| `crash_restarts` | Lives with this name on this host that ended without `stop()` before this one started |
| `crash_restarts_since` | When the first of those went quiet. Null when there were none |
| `started_on`, `heartbeat_on`, `stopped_on` | When it started, last beat, and stopped. A crashed instance never sets `stopped_on` |

## Querying

```sql
-- Live instances
SELECT name, host, pid, version FROM pgboss.instance
WHERE stopped_on IS NULL AND heartbeat_on >= now() - heartbeat_seconds * 3 * interval '1 second';

-- Connections per instance
SELECT i.name, i.host, count(a.pid) AS connections
FROM pgboss.instance i
LEFT JOIN pg_stat_activity a ON a.application_name = i.application_name
GROUP BY 1, 2;

-- Who works a queue
SELECT i.name, i.host, w->>'localConcurrency' AS concurrency
FROM pgboss.instance i, jsonb_array_elements(i.workers) w
WHERE w->>'queue' = 'emails';
```

## Cleanup

Rows whose heartbeat has not moved for 7 days are deleted during maintenance, stopped and quiet alike.
