# Constructor

## `new(connectionString)`

A string argument is a PostgreSQL connection string, in any of the formats the [pg](https://github.com/brianc/node-postgres) package accepts. The [pg docs](https://github.com/brianc/node-postgres/wiki/pg) have some examples.

```js
const boss = new PgBoss('postgres://user:pass@host:port/database?ssl=require');
```

## `new(options)`

Pass any of the [database](#database-options) and [other options](#options) below as properties of an object.

```js
const boss = new PgBoss({ connectionString, schema: 'jobs' })
```

## Database {#database-options}

How this instance connects to PostgreSQL and where its storage lives.

### `host`

String, defaults to "127.0.0.1"

### `port`

Int, defaults to 5432

### `ssl`

Boolean or object

### `database`

String, *required*

### `user`

String, *required*

### `password`

String

### `connectionString`

String

A PostgreSQL connection string. pg-boss parses it and uses it instead of `host`, `port`, `ssl`, `database`, `user`, `password`.

### `max`

Int, defaults to 10

Maximum number of connections, shared by every operation on this instance.

### `application_name`

String, defaults to `pgboss:` followed by the first 8 characters of the instance's id. That lets you tell each instance's connections apart in `pg_stat_activity` and join them to [`getInstances()`](./ops.md#getinstances-options). With `registerInstance: false` the default is `"pgboss"`.

### `connectionTimeoutMillis`

Int, defaults to 10000

How many milliseconds to wait for a new client from the pool before timing out. Set to `0` to disable the timeout and wait indefinitely.

### `db`

Object

Pass an object as `db` to bring your own database connection, such as an existing database service with its own connection pool. Setting this option bypasses the connection options above it.

The object needs a function named `executeSql` that lets the following code run without errors.

```js
const text = "select $1 as input"
const values = ['arg1']

const { rows } = await executeSql(text, values)

assert(rows[0].input === 'arg1')
```

Some of pg-boss's statements are several statements in one text, and pg-boss reads rows from statements before the last. For those, `executeSql` must return an array with every statement's result, the way `pg` does.

See [Custom type parsers](#custom-type-parsers) for how a global `pg-types` parser interacts with pg-boss, whether you bring your own pool or not.

### `schema`

String, defaults to "pgboss"

Database schema that contains all required storage objects. An unquoted name allows only alphanumeric characters and underscores, and can't start with a number. A quoted name (see below) allows any character except double quotes, single quotes, percent signs, periods, dollar signs, backslashes and control characters. Either way, the name can be at most 50 bytes.

To use a name that isn't a legal bare identifier, such as one containing dashes or a reserved word, quote it yourself:

```js
new PgBoss({ schema: '"My-Schema"' })
```

pg-boss uses the value verbatim as an identifier, so the quotes stay as written. `MySchema` and `"MySchema"` are different schemas, because PostgreSQL folds the unquoted form to `myschema`. pg-boss rejects double quotes, single quotes, percent signs, periods, dollar signs, backslashes and control characters inside a quoted name.

The length limit is in bytes because a quoted name can hold multi-byte characters. PostgreSQL silently truncates identifiers past 63 bytes, which would leave the configured name and the stored name out of sync for good.

The two spellings look nearly identical but name different schemas. So `start()` refuses to install into a schema when another schema that differs from it only by case already holds a pg-boss installation, and it names the spelling that reaches the existing data. Override this with [`allowSchemaCaseVariant`](#allowschemacasevariant) if you want two such installations.

### `createSchema`

Bool, default true

Set to false to skip the `CREATE SCHEMA` statement during installation, for a role that hasn't been granted that privilege.

### `allowSchemaCaseVariant`

Bool, default false

Set to true to let `start()` install into `schema` even when another schema differing from it only by case already holds a pg-boss installation.

The check this disables exists because `schema: 'MySchema'` and `schema: '"MySchema"'` name two different schemas. PostgreSQL folds the unquoted form to `myschema` and stores the quoted one verbatim. Getting the quoting wrong doesn't raise an error on its own. pg-boss finds no installation, creates an empty second schema, and every existing job seems to have vanished. Set this only if you want two installations whose names differ by case.

### `backend`

String, default `'postgres'`

Selects the database pg-boss is running against and applies the compatibility behavior it needs. One of `'postgres'`, `'cockroachdb'`, `'citus'`, or `'pglite'`.

```js
const boss = new PgBoss({ connectionString, backend: 'cockroachdb' })
```

This setting can change the fetch strategy, mutation strategy, schema shape and numeric coercion. See [Database Backends](../database-backends.md#backend-profiles)
for what each backend enables and the [compatibility matrix](../database-backends.md#database-compatibility).

### `useListenNotify`

Bool, default false

Enables a `LISTEN/NOTIFY` listener that wakes workers on notify-enabled queues the moment a job is created, so they don't wait out their `pollingIntervalSeconds`. It lowers latency on top of polling. Polling always stays active as a fallback, so a missed notification never loses a job. See [Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listen-notify) for how it works and for the per-queue `notify` option that controls which queues emit notifications.

This option holds one dedicated database connection open for listening. It needs a session-pinned connection, which the built-in connection pool and a `db` adapter that implements `listen` both provide. PgBouncer in transaction or statement pooling mode does **not**, because it disables `LISTEN/NOTIFY`. When pg-boss can't establish a listener, it emits a [`warning`](./events.md#warning) event of type `listen_notify_unavailable` and continues with polling only.

### `notifyHeartbeatIntervalMs`

Int, defaults to 10000

Interval between heartbeat checks on the dedicated LISTEN/NOTIFY connection. Lower values detect a silently dropped connection sooner, but run more heartbeat queries.

### `notifyHeartbeatTimeoutMs`

Int, defaults to 5000

Timeout for each LISTEN/NOTIFY heartbeat query. If a heartbeat doesn't complete within this window, pg-boss tears down the listener and reconnects it. Raise this on a loaded database where the default is too short.

### `notifyKeepAliveInitialDelayMs`

Int, defaults to 10000

TCP keepalive initial delay for the dedicated LISTEN/NOTIFY connection.

## Options

### `supervise`

Bool, default true

Set to false to skip flows, maintenance and monitoring on this instance. This is for advanced use, and you'd leave it on under normal circumstances.

### `schedule`

Bool, default true

Set to false to stop this instance from monitoring or creating scheduled jobs. This is for advanced use, such as testing, or a server whose clock is skewed when you want to turn off the skew warnings.

### `migrate`

Bool, default true

Set to false to skip schema migrations during `start()`. If schema migrations exist, `start()` throws an error and blocks usage. This is for advanced use, when the configured user account doesn't have privileges to change the schema.

### `superviseIntervalSeconds`

Int, default 60 seconds

The base interval for how often pg-boss monitors and maintains queues.

### `maintenanceIntervalSeconds`

Int, default 1 day

How often maintenance runs against queue tables to drop queued and completed jobs.

Maintenance deletes expired jobs, and the flow dependencies they leave behind, in batches. Each batch runs in its own transaction, so a large backlog never becomes one long transaction.

### `monitorIntervalSeconds`

Int, default 60 seconds

How often pg-boss checks each queue for backlogs and expired jobs, and calculates its stats.

pg-boss fails jobs past their expiration or heartbeat in batches too, so a fleet that stopped with many jobs active recovers in short transactions.

### `queueCacheIntervalSeconds`

Int, default 60 seconds

How often pg-boss refreshes the queue metadata it keeps in memory.

### `reindex`

Bool | object, default true

Rebuilds bloated job indexes with `REINDEX INDEX CONCURRENTLY` during maintenance.

Autovacuum reclaims heap space but never shrinks a btree, so a job index stays at the size of the largest backlog its queue has ever held. Every later vacuum then walks all of those pages, which becomes the dominant cost on a queue that has drained. pg-boss rebuilds an index only when it fails a density check, so a healthy installation never runs one.

Set to `false` to disable rebuilds. Detection keeps working, so bloat still raises an `index_bloat` [`warning`](./events.md#warning), and [`getReindexCommands()`](./ops.md#getreindexcommands-options) still returns the statements to run by hand. Indexes the connected role doesn't own get the same detection without rebuilds, and so do `db` adapters that wrap queries in a transaction, since `REINDEX CONCURRENTLY` can't run inside one.

CockroachDB skips this entirely, detection included. It stores data outside PostgreSQL's heap, so it has no btree page bloat to reclaim. It also rejects `REINDEX` and doesn't report the page counts the check reads.

Pass an object to change the thresholds:

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `minPages` | int | 128 | Ignore indexes smaller than this many 8 kB pages |
| `maxEntriesPerPage` | number | 5 | Live entries per page below which an index counts as bloated. A freshly built job index holds 140-170 |
| `minSizeRatio` | number | 4 | How many times larger than its live entries need an index must be. pg-boss estimates the needed size from `pg_stats`, so it doesn't mistake a wide `singletonKey`, which legitimately packs fewer than five entries per page, for bloat |
| `maxIndexBytes` | int | 2147483648 | Never rebuild an index larger than this |

```js
const boss = new PgBoss({
  connectionString,
  reindex: { maxIndexBytes: 512 * 1024 * 1024 }
})
```

Only [`supervise()`](./ops.md#supervise-name-options) accepts `force`. This option doesn't, because a timer that rebuilt every job index on every interval is never what you want.

### `reindexIntervalSeconds`

Int, default 1 day

How often the index bloat check runs. One instance per interval runs it, coordinated through the database, so adding instances doesn't multiply the work. Cannot exceed 24 hours.

### `monitorVacuum`

Bool, default true

Checks that vacuum is keeping up with the queues. Set `false` to disable.

The check takes one measurement and reports two [`warning`](./events.md#warning) types, because their fixes are opposite:

| warning | what it means | the fix |
| --- | --- | --- |
| `xmin_horizon` | vacuum runs and reclaims nothing | find and release whatever is pinning the horizon |
| `autovacuum_disabled` | nothing is vacuuming the table at all | turn autovacuum back on, or vacuum on a schedule that keeps up |

A pinned horizon is the precondition behind most reports of a Postgres queue degrading over time, and the queue's own counters can't show it. A backlog caused by too few workers looks exactly like one caused by vacuum reclaiming nothing. The check reads `pg_stat_user_tables` for pg-boss's own job tables across two supervise passes, so it measures the damage directly, and the first pass after a horizon is pinned never warns. [Warning types](./events.md#warning-types) lists what each one fires on and what it carries.

This option has no threshold to tune. A table qualifies at the point Postgres itself would vacuum it, which is `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × n_live_tup`. The check reads per-table storage parameters before cluster settings. Those settings set the sensitivity, so set them per table if you want one queue watched more or less closely:

```sql
ALTER TABLE pgboss.job_common SET (autovacuum_vacuum_scale_factor = 0.05);
```

An `xmin_horizon` warning names the holder it found. Track it down through `pg_stat_activity` for idle-in-transaction backends and `pg_replication_slots` for unread slots. Where the connected role can't read one of those catalogs, `unreadableSources` says so, so a partial answer never passes for a clean one.

Not available on CockroachDB, which reclaims on its own schedule rather than from the oldest live snapshot.

### `flowIntervalSeconds`

Int, default 5 seconds

How often the background flow resolver runs to unblock dependent jobs (created via [`flow()`](./jobs.md#flow-jobs-options)) whose parents have completed. Completing a job doesn't unblock its dependents inline. The resolver does it shortly after, off the completion hot path. It runs only when `supervise` is enabled.

### `warningSlowQuerySeconds`

Int, default 30

The threshold, in seconds, above which a monitoring or maintenance query emits a `slow_query` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1.

### `warningQueueSize`

Int, default 10000

The default number of jobs in the created or retry state a queue can hold before pg-boss emits a `queue_backlog` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1. Individual queues can override this with their own [`warningQueueSize`](./queues.md#createqueue-name-queue) on `createQueue`.

### `persistWarnings`

Bool, default false

Set to true to store warnings in the `warning` table as well as emitting them as events. That covers warnings from monitoring and maintenance (slow queries, queue backlogs, clock skew) and from workers (handlers that outran their timeout). The stored rows give you a history of warnings for debugging and monitoring. See [Events](./events.md#warning) for the warning types.

### `warningRetentionDays`

Int, default 365

When `persistWarnings` is enabled, maintenance deletes warnings older than this many days. Maximum: 365 days.

### `persistQueueStats`

Bool, default false

Set to true to store the per-queue stats captured during monitoring in the `queue_stats` table as well as the `queue` table. [`getQueueStats()`](./queues.md#getqueuestats-name-options) reads this data and can downsample it into time buckets (`bucketSeconds` / `maxDataPoints`) for graphing. The data is partitioned by day, and maintenance prunes it automatically.

### `queueStatRetentionDays`

Int, default 7

When `persistQueueStats` is enabled, maintenance removes stats older than this many days. Maximum: 365 days.

With table partitioning, each supervise pass drops old days as whole partitions. Without it (`noTablePartitioning`, as on CockroachDB), each supervise pass deletes old rows in batches, oldest first, through an index on the capture time.

### `registerInstance`

Bool, default true

Records this instance in the database's `instance` table at `start()`, keeps the row current on a heartbeat, and marks it stopped on `stop()`. [`getInstances()`](./ops.md#getinstances-options) lists every pg-boss instance connecting to this schema. Set to false to leave this instance out of the registry. 

> [!NOTE]
> Short-lived processes such as serverless functions should set this to false, since their frequent registrations would falsely show instances as frozen or crashed.

### `instanceName`

String, optional

A label for this instance in the registry, such as `api` or `billing-worker`. It doesn't need to be unique, since each instance is recorded under its own id. Instances with the same name are grouped for pruning stopped rows and for counting crash restarts. See [`getInstances()`](./ops.md#getinstances-options).

The [proxy](../proxy.md) registers as `pg-boss-proxy`, and [dashboard](../dashboard.md) 1.12.x as `pg-boss-dashboard`. Dashboard 2.0 starts no instance.

### `instanceHeartbeatSeconds`

Int, default 30

How often this instance refreshes its registry row. Once it misses three heartbeats, it reads as quiet instead of live. Must be from 1 to 3600.

### `openTelemetry`

Object, see [OpenTelemetry](../opentelemetry.md#options)

Tracing and metrics through the OpenTelemetry API. It's on by default, and does nothing until the application registers an OpenTelemetry SDK. Set `enabled: false` to turn it off.

## Testing

These options exist for tests. Leave them unset in production.

### `clock`

Object, default the system clock

Where this instance reads the time and schedules its timers: every poll, heartbeat, cron pass, backoff and timeout. Pass a [`TestClock`](./testing.md#controlling-time) to drive time by hand in tests. It also takes over the Postgres side, so `${schema}.job_now()` reports the same time for pg-boss's own statements. pg-boss accepts any object with `now`, `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval`.

### `__test__enableSpies`

Bool, default false

Enables [`getSpy()`](./testing.md#getspy-name) for deterministic tests. It adds tracking overhead on every state transition, so leave it unset in production.

## Custom type parsers

pg-boss doesn't re-parse the values it reads back, so whatever a global [`pg-types`](https://github.com/brianc/node-pg-types) parser returns reaches pg-boss, and the public API, unchanged. This applies whether you pass your own [`db`](#db) or let pg-boss build the pool, because `pg.types.setTypeParser()` is global to the `pg` module either way.

The common case is a `timestamptz` parser that returns something other than a `Date`, `Temporal.Instant` and Luxon's `DateTime` in particular. pg-boss does its own timestamp arithmetic in SQL rather than in JavaScript, so it supports such a parser, with two consequences:

* Types that document a `Date`, such as `capturedOn` on [`getQueueStats()`](./queues.md#getqueuestats-name-options) or `createdOn` on a job, will hold whatever your parser returned. The declared type describes what the default parser produces, and pg-boss doesn't convert values to it.
* A value that throws on coercion, which every `Temporal` type does from `valueOf` by design, is safe to hand back. pg-boss never coerces one.
