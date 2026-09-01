# Constructor

### `new(connectionString)`

Passing a string argument to the constructor implies a PostgreSQL connection string in one of the formats specified by the [pg](https://github.com/brianc/node-postgres) package.  Some examples are currently posted in the [pg docs](https://github.com/brianc/node-postgres/wiki/pg).

```js
const boss = new PgBoss('postgres://user:pass@host:port/database?ssl=require');
```

### `new(options)`

The following options can be set as properties in an object for additional configurations.

**Connection options**

* **host** - string,  defaults to "127.0.0.1"

* **port** - int,  defaults to 5432

* **ssl** - boolean or object

* **database** - string, *required*

* **user** - string, *required*

* **password** - string

* **connectionString** - string

  PostgreSQL connection string will be parsed and used instead of `host`, `port`, `ssl`, `database`, `user`, `password`.

* **max** - int, defaults to 10

  Maximum number of connections that will be shared by all operations in this instance

* **application_name** - string, defaults to "pgboss"

* **connectionTimeoutMillis** - int, defaults to 10000

  Number of milliseconds to wait before timing out when acquiring a new client from the pool. Set to `0` to disable the timeout and wait indefinitely.

* **notifyHeartbeatIntervalMs** - int, defaults to 10000

  Interval between heartbeat checks on the dedicated LISTEN/NOTIFY connection. Lower values detect silent connection drops faster at the cost of more heartbeat queries.

* **notifyHeartbeatTimeoutMs** - int, defaults to 5000

  Timeout for each LISTEN/NOTIFY heartbeat query. If a heartbeat does not complete within this window the listener is torn down and reconnected. Raise this on a loaded database where the default is too aggressive.

* **notifyKeepAliveInitialDelayMs** - int, defaults to 10000

  TCP keepalive initial delay for the dedicated LISTEN/NOTIFY connection.

* **db** - object

    Passing an object named db allows you "bring your own database connection". This option may be beneficial if you'd like to use an existing database service with its own connection pool. Setting this option will bypass the above configuration.

    The expected interface is a function named `executeSql` that allows the following code to run without errors.


    ```js
    const text = "select $1 as input"
    const values = ['arg1']

    const { rows } = await executeSql(text, values)

    assert(rows[0].input === 'arg1')
    ```

* **schema** - string, defaults to "pgboss"

    Database schema that contains all required storage objects. Unquoted, only alphanumeric and underscore are allowed, and the name may not start with a number. Quoted (see below), any character is allowed except double quotes, single quotes, percent signs, periods, dollar signs, backslashes and control characters. Either way the limit is <= 50 bytes.

    To use a name that isn't a legal bare identifier — one containing dashes, or a reserved word — quote it yourself:

    ```js
    new PgBoss({ schema: '"My-Schema"' })
    ```

    The value is used verbatim as an identifier, so the quotes are preserved as written. Note that `MySchema` and `"MySchema"` are different schemas: PostgreSQL folds the unquoted form to `myschema`. Double quotes, single quotes, percent signs, periods, dollar signs, backslashes and control characters are rejected inside a quoted name.

    The length limit is measured in bytes, since it's possible to use multi-byte characters inside a quoted name. PostgreSQL truncates identifiers past 63 bytes without complaint, which would leave the configured name and the stored name permanently out of sync.

    Because the two spellings look nearly identical but name different schemas, `start()` refuses to install into a schema when another one differing from it only by case already holds a pg-boss installation, and names the spelling that reaches the existing data. Override with [`allowSchemaCaseVariant`](#allowschemacasevariant) if two such installations are genuinely intended.


**Operations options**

* **supervise**, bool, default true

  If this is set to false, flows, maintenance, and monitoring operations will be skipped on this instance. This is an advanced use case, and not something you would want to do under normal circumstances.

* **schedule**, bool, default true

  If this is set to false, this instance will not monitor or created scheduled jobs during. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

* **migrate**, bool, default true

  If this is set to false, this instance will skip attempts to run schema migrations during `start()`. If schema migrations exist, `start()` will throw and error and block usage. This is an advanced use case when the configured user account does not have schema mutation privileges.

* **useListenNotify**, bool, default false

  Enables a `LISTEN/NOTIFY` listener so that workers on notify-enabled queues are woken the moment a job is created, instead of waiting out their `pollingIntervalSeconds`. This is a latency optimization layered on top of polling — polling always remains active as a fallback, so jobs are never lost if a notification is missed. See [Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listen-notify) for the full picture and the per-queue `notify` option that controls which queues emit notifications.

  This option holds one dedicated database connection open for listening. It requires a session-pinned connection: it works with the built-in connection pool and with a `db` adapter that implements `listen`, but **not** through PgBouncer in transaction or statement pooling mode, which disables `LISTEN/NOTIFY`. When a listener cannot be established, pg-boss emits a [`warning`](./events.md#warning) event of type `listen_notify_unavailable` and continues with polling only.

The following configuration options should not normally need to be changed, but are still available for special use cases.

* **createSchema**, bool, default true
  
  If set to false, the `CREATE SCHEMA` statement will not be issued during installation. This may be useful if this privilege is not granted to the role.

* **allowSchemaCaseVariant**, bool, default false

  If set to true, `start()` will install into `schema` even when another schema differing from it only by case already holds a pg-boss installation.

  The check this disables exists because `schema: 'MySchema'` and `schema: '"MySchema"'` name two different schemas — PostgreSQL folds the unquoted form to `myschema` and stores the quoted one verbatim. Mis-spelling the quoting is not an error on its own: pg-boss simply finds no installation, creates an empty second schema, and every existing job appears to have vanished. Only set this if two installations whose names differ by case are intended.

* **superviseIntervalSeconds**, int, default 60 seconds

  Entry point for how often queues are monitored and maintained.

* **maintenanceIntervalSeconds**, int, default 1 day

  How often maintenance will be run against queue tables to drop queued and completed jobs.

* **monitorIntervalSeconds**, int, default 60 seconds 

  How often each queue is monitored for backlogs, expired jobs, and calculating stats.

* **queueCacheIntervalSeconds**, int, default 60 seconds

  How often queue metadata is refreshed in memory.

* **reindex**, bool | object, default true

  Rebuilds bloated job indexes with `REINDEX INDEX CONCURRENTLY` during maintenance.

  Autovacuum reclaims heap space but never shrinks a btree, so a job index stays at the size of the largest backlog its queue has ever held. Every later vacuum then walks all of those pages, which becomes the dominant cost on a queue that has drained. Rebuilds are gated on an index density check, so a healthy installation never runs one.

  Set to `false` to disable rebuilds. Detection is unaffected: bloat still raises an `index_bloat` [`warning`](./events.md#warning), and [`getReindexCommands()`](./ops.md#getreindexcommandsoptions) still returns the statements to run by hand. The same applies to indexes the connected role does not own, and to `db` adapters that wrap queries in a transaction — `REINDEX CONCURRENTLY` cannot run inside one.

  CockroachDB and YugabyteDB skip this entirely, detection included. They store data outside PostgreSQL's heap, so there is no btree page bloat to reclaim, they reject `REINDEX`, and neither reports the page counts the check reads.

  Pass an object to change the thresholds:

  | Property | Type | Default | Description |
  | --- | --- | --- | --- |
  | `minPages` | int | 128 | Ignore indexes smaller than this many 8 kB pages |
  | `maxEntriesPerPage` | number | 5 | Live entries per page below which an index counts as bloated. A freshly built job index holds 140-170 |
  | `minSizeRatio` | number | 4 | How many times larger than its live entries need an index must be. The needed size is estimated from `pg_stats`, so a wide `singletonKey` — which legitimately packs fewer than five entries per page — is not mistaken for bloat |
  | `maxIndexBytes` | int | 2147483648 | Never rebuild an index larger than this |

  ```js
  const boss = new PgBoss({
    connectionString,
    reindex: { maxIndexBytes: 512 * 1024 * 1024 }
  })
  ```

  `force` is only accepted by [`supervise()`](./ops.md#supervisename-options), not here — a timer that rebuilt every job index on every interval is never what you want.

* **reindexIntervalSeconds**, int, default 1 day

  How often the index bloat check runs. One instance per interval performs it, coordinated through the database, so adding instances does not multiply the work. Cannot exceed 24 hours.

* **monitorVacuum**, bool, default true

  Whether to check that vacuum is keeping up with the queues. Set `false` to disable.

  One measurement, two [`warning`](./events.md#warning) types, because the fixes are opposite:

  | warning | what it means | the fix |
  | --- | --- | --- |
  | `xmin_horizon` | vacuum runs and reclaims nothing | find and release whatever is pinning the horizon |
  | `autovacuum_disabled` | nothing is vacuuming the table at all | turn autovacuum back on, or vacuum on a schedule that keeps up |

  While something holds the horizon back — a backend sitting in an open transaction, a lagging replication slot, a standby with `hot_standby_feedback` enabled, or a prepared transaction — autovacuum cannot reclaim anything your queues delete. Dead tuples accumulate, indexes bloat, and every later vacuum pass gets more expensive. This is the precondition behind most reports of a Postgres queue degrading over time, and it is invisible from the queue's own counters: a backlog caused by too few workers and a backlog caused by a pinned horizon look identical and have opposite fixes.

  There is no threshold to tune, because the check measures the damage rather than guessing at it. It reads `pg_stat_user_tables` for pg-boss's own job tables. Both warnings share a first condition:

  1. a job table is past the point Postgres itself would vacuum it — `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × n_live_tup`, honouring per-table storage parameters over the cluster settings.

  Two consecutive passes then decide which diagnosis applies. For `xmin_horizon`:

  2. a vacuum has since run on that table and the dead-tuple count did not fall, so vacuum tried and reclaimed nothing — this is what separates a pinned horizon from ordinary churn, where a vacuum drops the count sharply;
  3. a horizon holder exists that is old enough to explain it — for a backend, one whose transaction was already open when that vacuum ran; for a replication slot, standby or prepared transaction, any at all, since those advertise an xmin only while something is genuinely stuck.

  For `autovacuum_disabled`, instead:

  2. the table has `autovacuum_enabled = false`, no vacuum ran between the two passes, and the dead-tuple count grew.

  Turning autovacuum off on a queue table and vacuuming on your own schedule is a legitimate setup, and it stays quiet: a manual vacuum both moves the timestamp and drops the count, so neither branch matches. The warning is for the case where nothing is running at all.

  Sensitivity is therefore tuned with Postgres's own autovacuum settings, per table if you want a particular queue watched more or less closely:

  ```sql
  ALTER TABLE pgboss.job_common SET (autovacuum_vacuum_scale_factor = 0.05);
  ```

  Because the second condition compares two observations, the first supervise pass after a horizon is pinned never warns; the warning arrives on a later pass, once a vacuum has actually failed.

  The `xmin_horizon` warning names which holder is responsible so it can be tracked down — start with `pg_stat_activity` for idle-in-transaction backends and `pg_replication_slots` for unread slots. If the connected role cannot read one of those catalogs, the warning's `unreadableSources` lists what could not be checked, so a partial answer is never reported as a clean one.

  Not available on CockroachDB or YugabyteDB, which reclaim on their own schedule rather than from the oldest live snapshot.

* **flowIntervalSeconds**, int, default 5 seconds

  How often the background flow resolver runs to unblock dependent jobs (created via [`flow()`](./jobs.md#flowjobs-options)) whose parents have completed. Completing a job no longer unblocks its dependents inline; this resolver handles it shortly after, off the completion hot path. Only runs when `supervise` is enabled.

* **warningSlowQuerySeconds**, int, default 30

  The threshold, in seconds, above which a monitoring or maintenance query emits a `slow_query` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1.

* **warningQueueSize**, int, default 10000

  The default number of jobs in the created or retry state a queue may hold before emitting a `queue_backlog` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1. Individual queues can override this with their own [`warningQueueSize`](./queues.md#createqueue-name-queue) on `createQueue`.

* **persistWarnings**, bool, default false

  If set to true, warnings emitted during monitoring and maintenance (slow queries, queue backlogs, clock skew) will be persisted to the `warning` table in addition to being emitted as events. This enables historical tracking of warnings for debugging and monitoring purposes. See [Events](./events.md#warning) for more details on warning types.

* **warningRetentionDays**, int

  When `persistWarnings` is enabled, this option controls automatic cleanup of old warnings. Warnings older than the specified number of days will be deleted during maintenance. If not set, warnings are retained indefinitely. Maximum: 365 days.

* **persistQueueStats**, bool, default false

  If set to true, the per-queue counts captured during monitoring (deferred, queued, ready, active, failed, and total) are written to the `queue_stats` table on every monitor cycle, in addition to updating the live counts on the `queue` table. This builds a time series of queue depth that you can query with [`getQueueStats()`](./queues.md#getqueuestatsname-options), which can downsample the series into time buckets (`bucketSeconds` / `maxDataPoints`) for graphing. Data is partitioned by day, pruned automatically during maintenance.

* **queueStatRetentionDays**, int, default 7

  When `persistQueueStats` is enabled, this controls automatic cleanup of old snapshots. Stats older than the specified number of days are removed during maintenance. Maximum: 365 days.

* **backend**, string, default `'postgres'`

  Selects the database pg-boss is running against and applies the compatibility behavior it needs. One of `'postgres'`, `'cockroachdb'`, `'yugabytedb'`, `'citus'`, or `'pglite'`.

  ```js
  const boss = new PgBoss({ connectionString, backend: 'cockroachdb' })
  ```

  Based on this setting, the fetch strategy, mutation strategy, schema shape, and numeric coercion may be changed. See [Database Backends](../database-backends.md#backend-profiles)
  for what each backend enables and the [compatibility matrix](../database-backends.md#database-compatibility).
