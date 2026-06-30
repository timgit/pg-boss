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

    Database schema that contains all required storage objects. Only alphanumeric and underscore allowed, length: <= 50 characters


**Operations options**

* **supervise**, bool, default true

  If this is set to false, flows, maintenance, and monitoring operations will be skipped on this instance. This is an advanced use case, and not something you would want to do under normal circumstances.

* **schedule**, bool, default true

  If this is set to false, this instance will not monitor or created scheduled jobs during. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

* **migrate**, bool, default true

  If this is set to false, this instance will skip attempts to run schema migrations during `start()`. If schema migrations exist, `start()` will throw and error and block usage. This is an advanced use case when the configured user account does not have schema mutation privileges.

* **useListenNotify**, bool, default false

  Enables a `LISTEN/NOTIFY` listener so that workers on notify-enabled queues are woken the moment a job is created, instead of waiting out their `pollingIntervalSeconds`. This is a latency optimization layered on top of polling — polling always remains active as a fallback, so jobs are never lost if a notification is missed. See [Workers › Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listennotify) for the full picture and the per-queue `notify` option that controls which queues emit notifications.

  This option holds one dedicated database connection open for listening. It requires a session-pinned connection: it works with the built-in connection pool and with a `db` adapter that implements `listen`, but **not** through PgBouncer in transaction or statement pooling mode, which disables `LISTEN/NOTIFY`. When a listener cannot be established, pg-boss emits a [`warning`](./events.md#warning) event of type `listen_notify_unavailable` and continues with polling only.

The following configuration options should not normally need to be changed, but are still available for special use cases.

* **createSchema**, bool, default true
  
  If set to false, the `CREATE SCHEMA` statement will not be issued during installation. This may be useful if this privilege is not granted to the role.

* **superviseIntervalSeconds**, int, default 60 seconds

  Entry point for how often queues are monitored and maintained.

* **maintenanceIntervalSeconds**, int, default 1 day

  How often maintenance will be run against queue tables to drop queued and completed jobs.

* **monitorIntervalSeconds**, int, default 60 seconds 

  How often each queue is monitored for backlogs, expired jobs, and calculating stats.

* **queueCacheIntervalSeconds**, int, default 60 seconds

  How often queue metadata is refreshed in memory.

* **flowIntervalSeconds**, int, default 5 seconds

  How often the background flow resolver runs to unblock dependent jobs (created via [`flow()`](./jobs.md#flowjobs-options)) whose parents have completed. Completing a job no longer unblocks its dependents inline; this resolver handles it shortly after, off the completion hot path. Only runs when `supervise` is enabled.

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
