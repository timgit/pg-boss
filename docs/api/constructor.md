# Constructor

### `new(connectionString)`

Passing a string argument to the constructor implies a PostgreSQL connection string, passed to [Bun's SQL client](https://bun.com/docs/api/sql) as its connection URL.

```js
const boss = new BunBoss('postgres://user:pass@host:port/database?ssl=require');
```

### `new(options)`

The following options can be set as properties in an object for additional configurations.

**Connection options**

* **host** - string,  defaults to "127.0.0.1"

* **port** - int,  defaults to 5432

* **ssl** - boolean or object

  Passed to Bun's SQL client as its `tls` option.

* **database** - string, *required*

* **user** - string, *required*

* **password** - string

* **connectionString** - string

  PostgreSQL connection string will be parsed and used instead of `host`, `port`, `ssl`, `database`, `user`, `password`.

* **max** - int, defaults to 10

  Maximum number of connections that will be shared by all operations in this instance

* **application_name** - string, defaults to "bunboss"

* **connectionTimeoutMillis** - int, defaults to 10000

  Number of milliseconds to wait when establishing a connection. Bun's SQL client takes this timeout in seconds, so the value is converted (sub-second granularity is not guaranteed).

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
    new BunBoss({ schema: '"My-Schema"' })
    ```

    The value is used verbatim as an identifier, so the quotes are preserved as written. Note that `MySchema` and `"MySchema"` are different schemas: PostgreSQL folds the unquoted form to `myschema`. Double quotes, single quotes, percent signs, periods, dollar signs, backslashes and control characters are rejected inside a quoted name.

    The length limit is measured in bytes, since it's possible to use multi-byte characters inside a quoted name. PostgreSQL truncates identifiers past 63 bytes without complaint, which would leave the configured name and the stored name permanently out of sync.

    Because the two spellings look nearly identical but name different schemas, `start()` refuses to install into a schema when another one differing from it only by case already holds a bun-boss installation, and names the spelling that reaches the existing data. Override with [`allowSchemaCaseVariant`](#allowschemacasevariant) if two such installations are genuinely intended.


**Operations options**

* **supervise**, bool, default true

  If this is set to false, flows, maintenance, and monitoring operations will be skipped on this instance. This is an advanced use case, and not something you would want to do under normal circumstances.

* **schedule**, bool, default true

  If this is set to false, this instance will not monitor or created scheduled jobs during. This is an advanced use case you may want to do for testing or if the clock of the server is skewed and you would like to disable the skew warnings.

* **migrate**, bool, default true

  If this is set to false, this instance will verify the schema during `start()` instead of installing it, skipping any schema mutation. If the schema is missing, `start()` will throw an error and block usage. This is an advanced use case when the configured user account does not have schema mutation privileges.

* **useListenNotify**, bool, default false

  Enables a `LISTEN/NOTIFY` listener so that workers on notify-enabled queues are woken the moment a job is created, instead of waiting out their `pollingIntervalSeconds`. This is a latency optimization layered on top of polling — polling always remains active as a fallback, so jobs are never lost if a notification is missed. See [Low-latency dispatch with LISTEN/NOTIFY](./workers.md#low-latency-dispatch-with-listen-notify) for the full picture and the per-queue `notify` option that controls which queues emit notifications.

  This option requires a `db` adapter that implements `listen` (e.g. `fromPglite`). The built-in driver — Bun's SQL client — implements no LISTEN, so with it bun-boss emits a [`warning`](./events.md#warning) event of type `listen_notify_unavailable` and continues with polling only. The producer side (`pg_notify` inlined into inserts) still fires either way, so a listener on another connection can act on it.

The following configuration options should not normally need to be changed, but are still available for special use cases.

* **createSchema**, bool, default true
  
  If set to false, the `CREATE SCHEMA` statement will not be issued during installation. This may be useful if this privilege is not granted to the role.

* **allowSchemaCaseVariant**, bool, default false

  If set to true, `start()` will install into `schema` even when another schema differing from it only by case already holds a bun-boss installation.

  The check this disables exists because `schema: 'MySchema'` and `schema: '"MySchema"'` name two different schemas — PostgreSQL folds the unquoted form to `myschema` and stores the quoted one verbatim. Mis-spelling the quoting is not an error on its own: bun-boss simply finds no installation, creates an empty second schema, and every existing job appears to have vanished. Only set this if two installations whose names differ by case are intended.

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

* **warningSlowQuerySeconds**, int, default 30

  The threshold, in seconds, above which a monitoring or maintenance query emits a `slow_query` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1.

* **warningQueueSize**, int, default 10000

  The default number of jobs in the created or retry state a queue may hold before emitting a `queue_backlog` [`warning`](./events.md#warning) event. Applies per instance and must be at least 1. Individual queues can override this with their own [`warningQueueSize`](./queues.md#createqueue-name-queue) on `createQueue`.

* **backend**, string, default `'postgres'`

  Selects the database bun-boss is running against and applies the compatibility behavior it needs. One of `'postgres'`, `'pglite'`, or `'sqlite'`.

  ```js
  const boss = new BunBoss({ connectionString, backend: 'sqlite' })
  ```

  Based on this setting, the fetch strategy, mutation strategy, and schema shape may be changed. See [Database Backends](../database-backends.md#backend-profiles)
  for what each backend enables and the [compatibility matrix](../database-backends.md#database-compatibility).
