# Constructor

## `new(connectionString)`

Passing a string argument to the constructor implies a PostgreSQL connection string in one of the formats specified by the [pg](https://github.com/brianc/node-postgres) package.  Some examples are currently posted in the [pg docs](https://github.com/brianc/node-postgres/wiki/pg).

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

PostgreSQL connection string will be parsed and used instead of `host`, `port`, `ssl`, `database`, `user`, `password`.

### `max`

Int, defaults to 10

Maximum number of connections that will be shared by all operations in this instance

### `application_name`

String, defaults to "pgboss"

### `connectionTimeoutMillis`

Int, defaults to 10000

Number of milliseconds to wait before timing out when acquiring a new client from the pool. Set to `0` to disable the timeout and wait indefinitely.

### `db`

Object

Passing an object named db allows you "bring your own database connection". This option may be beneficial if you'd like to use an existing database service with its own connection pool. Setting this option bypasses the connection options above it.

The expected interface is a function named `executeSql` that allows the following code to run without errors.

```js
const text = "select $1 as input"
const values = ['arg1']

const { rows } = await executeSql(text, values)

assert(rows[0].input === 'arg1')
```

See [Custom type parsers](#custom-type-parsers) for how a global `pg-types` parser interacts with pg-boss, whether you bring your own pool or not.

### `schema`

String, defaults to "pgboss"

Database schema that contains all required storage objects. Unquoted, only alphanumeric and underscore are allowed, and the name may not start with a number. Quoted (see below), any character is allowed except double quotes, single quotes, percent signs, periods, dollar signs, backslashes and control characters. Either way the limit is <= 50 bytes.

To use a name that isn't a legal bare identifier, such as one containing dashes or a reserved word, quote it yourself:

```js
new PgBoss({ schema: '"My-Schema"' })
```

The value is used verbatim as an identifier, so the quotes are preserved as written. Note that `MySchema` and `"MySchema"` are different schemas: PostgreSQL folds the unquoted form to `myschema`. Double quotes, single quotes, percent signs, periods, dollar signs, backslashes and control characters are rejected inside a quoted name.

The length limit is measured in bytes, since it's possible to use multi-byte characters inside a quoted name. PostgreSQL truncates identifiers past 63 bytes without complaint, which would leave the configured name and the stored name permanently out of sync.

Because the two spellings look nearly identical but name different schemas, `start()` refuses to install into a schema when another one differing from it only by case already holds a pg-boss installation, and names the spelling that reaches the existing data. Override with [`allowSchemaCaseVariant`](#allowschemacasevariant) if two such installations are genuinely intended.

### `createSchema`

Bool, default true

If set to false, the `CREATE SCHEMA` statement will not be issued during installation. This may be useful if this privilege is not granted to the role.

### `allowSchemaCaseVariant`

Bool, default false

If set to true, `start()` will install into `schema` even when another schema differing from it only by case already holds a pg-boss installation.

The check this disables exists because `schema: 'MySchema'` and `schema: '"MySchema"'` name two different schemas. PostgreSQL folds the unquoted form to `myschema` and stores the quoted one verbatim. Mis-spelling the quoting is not an error on its own: pg-boss simply finds no installation, creates an empty second schema, and every existing job appears to have vanished. Only set this if two installations whose names differ by case are intended.

### `backend`

String, default `'postgres'`

Selects the database pg-boss is running against and applies the compatibility behavior it needs. One of `'postgres'`, `'cockroachdb'`, `'yugabytedb'`, `'citus'`, or `'pglite'`.

```js
const boss = new PgBoss({ connectionString, backend: 'cockroachdb' })
```

Based on this setting, the fetch strategy, mutation strategy, schema shape, and numeric coercion may be changed. See [Database Backends](../database-backends.md#backend-profiles)
for what each backend enables and the [compatibility matrix](../database-backends.md#database-compatibility).

### `useListenNotify`

Bool, default false

Enables a `LISTEN/NOTIFY` listener so that workers on notify-enabled queues are woken the moment a job is created, instead of waiting out their `pollingIntervalSeconds`. This is a latency optimization layered on top of polling. Polling always remains active as a fallback, so jobs are never lost if a notification is missed. See [Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listen-notify) for the full picture and the per-queue `notify` option that controls which queues emit notifications.

This option holds one dedicated database connection open for listening. It requires a session-pinned connection: it works with the built-in connection pool and with a `db` adapter that implements `listen`, but **not** through PgBouncer in transaction or statement pooling mode, which disables `LISTEN/NOTIFY`. When a listener cannot be established, pg-boss emits a [`warning`](./events.md#warning) event of type `listen_notify_unavailable` and continues with polling only.

### `notifyHeartbeatIntervalMs`

Int, defaults to 10000

Interval between heartbeat checks on the dedicated LISTEN/NOTIFY connection. Lower values detect silent connection drops faster at the cost of more heartbeat queries.

### `notifyHeartbeatTimeoutMs`

Int, defaults to 5000

Timeout for each LISTEN/NOTIFY heartbeat query. If a heartbeat does not complete within this window the listener is torn down and reconnected. Raise this on a loaded database where the default is too aggressive.

### `notifyKeepAliveInitialDelayMs`

Int, defaults to 10000

TCP keepalive initial delay for the dedicated LISTEN/NOTIFY connection.

## Options

### `supervise`

Bool, default true

If this is set to false, flows, maintenance, and monitoring operations will be skipped on this instance. This is an advanced use case, and not something you would want to do under normal circumstances.

### `schedule`

Bool, default true

If this is set to false, this instance will not monitor or created scheduled jobs during. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

### `migrate`

Bool, default true

If this is set to false, this instance will skip attempts to run schema migrations during `start()`. If schema migrations exist, `start()` will throw and error and block usage. This is an advanced use case when the configured user account does not have schema mutation privileges.

### `superviseIntervalSeconds`

Int, default 60 seconds

Entry point for how often queues are monitored and maintained.

### `maintenanceIntervalSeconds`

Int, default 1 day

How often maintenance will be run against queue tables to drop queued and completed jobs.

### `monitorIntervalSeconds`

Int, default 60 seconds

How often each queue is monitored for backlogs, expired jobs, and calculating stats.

### `queueCacheIntervalSeconds`

Int, default 60 seconds

How often queue metadata is refreshed in memory.

### `reindex`

Bool | object, default true

Rebuilds bloated job indexes with `REINDEX INDEX CONCURRENTLY` during maintenance.

Autovacuum reclaims heap space but never shrinks a btree, so a job index stays at the size of the largest backlog its queue has ever held. Every later vacuum then walks all of those pages, which becomes the dominant cost on a queue that has drained. Rebuilds are gated on an index density check, so a healthy installation never runs one.

Set to `false` to disable rebuilds. Detection is unaffected: bloat still raises an `index_bloat` [`warning`](./events.md#warning), and [`getReindexCommands()`](./ops.md#getreindexcommandsoptions) still returns the statements to run by hand. The same applies to indexes the connected role does not own, and to `db` adapters that wrap queries in a transaction, since `REINDEX CONCURRENTLY` cannot run inside one.

CockroachDB and YugabyteDB skip this entirely, detection included. They store data outside PostgreSQL's heap, so there is no btree page bloat to reclaim, they reject `REINDEX`, and neither reports the page counts the check reads.

Pass an object to change the thresholds:

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `minPages` | int | 128 | Ignore indexes smaller than this many 8 kB pages |
| `maxEntriesPerPage` | number | 5 | Live entries per page below which an index counts as bloated. A freshly built job index holds 140-170 |
| `minSizeRatio` | number | 4 | How many times larger than its live entries need an index must be. The needed size is estimated from `pg_stats`, so a wide `singletonKey`, which legitimately packs fewer than five entries per page, is not mistaken for bloat |
| `maxIndexBytes` | int | 2147483648 | Never rebuild an index larger than this |

```js
const boss = new PgBoss({
  connectionString,
  reindex: { maxIndexBytes: 512 * 1024 * 1024 }
})
```

`force` is only accepted by [`supervise()`](./ops.md#supervisename-options), not here. A timer that rebuilt every job index on every interval is never what you want.

### `reindexIntervalSeconds`

Int, default 1 day

How often the index bloat check runs. One instance per interval performs it, coordinated through the database, so adding instances does not multiply the work. Cannot exceed 24 hours.

### `monitorVacuum`

Bool, default true

Whether to check that vacuum is keeping up with the queues. Set `false` to disable.

One measurement, two [`warning`](./events.md#warning) types, because the fixes are opposite:

| warning | what it means | the fix |
| --- | --- | --- |
| `xmin_horizon` | vacuum runs and reclaims nothing | find and release whatever is pinning the horizon |
| `autovacuum_disabled` | nothing is vacuuming the table at all | turn autovacuum back on, or vacuum on a schedule that keeps up |

A pinned horizon is the precondition behind most reports of a Postgres queue degrading over time, and it is invisible from the queue's own counters: a backlog caused by too few workers looks exactly like one caused by vacuum reclaiming nothing. The check reads `pg_stat_user_tables` for pg-boss's own job tables across two supervise passes, so it measures the damage rather than guessing at it, and the first pass after a horizon is pinned never warns. [Warning types](./events.md#warning-types) has what each one fires on and what it carries.

There is no threshold here to tune. A table qualifies at the point Postgres itself would vacuum it, which is `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × n_live_tup`, reading per-table storage parameters before cluster settings. Sensitivity therefore comes from those settings, per table if you want one queue watched more or less closely:

```sql
ALTER TABLE pgboss.job_common SET (autovacuum_vacuum_scale_factor = 0.05);
```

An `xmin_horizon` warning names the holder it found; track it down through `pg_stat_activity` for idle-in-transaction backends and `pg_replication_slots` for unread slots. Where the connected role cannot read one of those catalogs, `unreadableSources` says so, rather than reporting a partial answer as a clean one.

Not available on CockroachDB or YugabyteDB, which reclaim on their own schedule rather than from the oldest live snapshot.

### `flowIntervalSeconds`

Int, default 5 seconds

How often the background flow resolver runs to unblock dependent jobs (created via [`flow()`](./jobs.md#flowjobs-options)) whose parents have completed. Completing a job no longer unblocks its dependents inline; this resolver handles it shortly after, off the completion hot path. Only runs when `supervise` is enabled.

### `warningSlowQuerySeconds`

Int, default 30

The threshold, in seconds, above which a monitoring or maintenance query emits a `slow_query` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1.

### `warningQueueSize`

Int, default 10000

The default number of jobs in the created or retry state a queue may hold before emitting a `queue_backlog` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1. Individual queues can override this with their own [`warningQueueSize`](./queues.md#createqueue-name-queue) on `createQueue`.

### `persistWarnings`

Bool, default false

If set to true, warnings emitted during monitoring and maintenance (slow queries, queue backlogs, clock skew) will be persisted to the `warning` table in addition to being emitted as events. This enables historical tracking of warnings for debugging and monitoring purposes. See [Events](./events.md#warning) for more details on warning types.

### `warningRetentionDays`

Int, default 365

When `persistWarnings` is enabled, this option controls automatic cleanup of old warnings. Warnings older than the specified number of days will be deleted during maintenance. Maximum: 365 days.

### `persistQueueStats`

Bool, default false

If set to true, the per-queue stats captured during monitoring are also stored in the `queue_stats` table in addition to the `queue` table. This data can then be querired with [`getQueueStats()`](./queues.md#getqueuestatsname-options), which can optionally be downsampled into time buckets (`bucketSeconds` / `maxDataPoints`) for graphing. Data is partitioned by day and pruned automatically during maintenance.

### `queueStatRetentionDays`

Int, default 7

When `persistQueueStats` is enabled, this controls automatic cleanup of old snapshots. Stats older than the specified number of days are removed during maintenance. Maximum: 365 days.

## Testing

These options exist for tests. Leave them unset in production.

### `clock`

Object, default the system clock

Where this instance reads the time and schedules its timers: every poll, heartbeat, cron pass, backoff and timeout. Pass a [`TestClock`](./testing.md#controlling-time) to drive time by hand in tests; it also takes over the Postgres side, so `${schema}.job_now()` reports the same time for pg-boss's own statements. Any object with `now`, `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval` is accepted. Leave unset in production.

### `__test__enableSpies`

Bool, default false

Enables [`getSpy()`](./testing.md#getspyname) for deterministic tests. Adds per-transition tracking overhead, so leave unset in production.

## Custom type parsers

pg-boss doesn't re-parse the values it reads back, so a global [`pg-types`](https://github.com/brianc/node-pg-types) parser reaches it, and reaches the public API, unchanged. This applies whether you pass your own [`db`](#db) or let pg-boss build the pool: `pg.types.setTypeParser()` is global to the `pg` module either way.

A `timestamptz` parser returning something other than a `Date` is the common case, `Temporal.Instant` and Luxon's `DateTime` in particular. pg-boss does its own timestamp arithmetic in SQL rather than in JavaScript, so such a parser is supported, with two consequences worth knowing:

* Types that document a `Date`, such as `capturedOn` on [`getQueueStats()`](./queues.md#getqueuestatsname-options) or `createdOn` on a job, will hold whatever your parser returned. The declared type is what the default parser produces, not a conversion pg-boss performs.
* A value that throws on coercion, which every `Temporal` type does from `valueOf` by design, is safe to hand back. pg-boss never coerces one.
