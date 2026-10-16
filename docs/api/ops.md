# Operations

### `start(options)`

Prepares the target database and starts job monitoring. Resolves the same PgBoss instance it was called on.

```js
await boss.start()
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects don't exist in the target database, **`start()` will automatically create them**. Updates work the same way. If a new schema version is required, pg-boss migrates its internal storage to the latest installed version.

> [!WARNING]
> During an upgrade, `start()` resolves only after the migration script has run against your data. For example, if the job table holds millions of jobs waiting for archiving and the next schema version adds a couple of indexes, `start()` can take a few seconds to resolve. Most migrations are very quick, and they're designed with performance in mind.

All schema operations, both first-time provisioning and migrations, run inside advisory locks to prevent race conditions during `start()`. pg-boss takes these locks with `pg_advisory_xact_lock()`, which releases them at the end of the transaction, so they need no persistent session and no explicit unlock. For databases that don't support advisory locks (like CockroachDB), select the matching backend (e.g. `backend: 'cockroachdb'`) and pg-boss adjusts accordingly.

For example, you can call `start()` while bootstrapping a pod in a Kubernetes ReplicaSet. When you scale up job processing with a container orchestrator like k8s, pg-boss needs no special startup handling.

If the database is unavailable, `start()` rejects. For a process that can start before its database is up, pass `attempts` so it tries again:

```js
await boss.start({ attempts: 10 })
```

You can also call `start()` again yourself on the same instance until it succeeds. Workers registered with [`work()`](./workers.md#work-name-options-handler) before then take jobs once it does, and until then they emit `error` on each poll.

**Options**

* **attempts**, int, default 1

  How many times to try before rejecting with the last error. Between tries `start()` waits 1 second, doubling up to 30 seconds, so 10 attempts span about two and a half minutes. The first failure emits a [`start_retry` warning](./events.md#warning), once per call. An `AssertionError` (pg-boss refusing a configuration it can't run) is never retried. A schema another process is still creating or migrating is retried, so an instance with `migrate: false` can wait for the one that migrates. Calling `stop()` during a wait ends it, and `start()` rejects with the last error. An instance that started on a later try records that try as `config.startAttempt` in [`getInstances()`](#getinstances-options).

Once started, pg-boss keeps running when the database drops and comes back. Workers emit `error` while it's gone and resume when it returns, with no restart needed.

### `stop(options)`

Stops all background processing, such as maintenance and scheduling, as well as all polling workers started with `work()`.

By default, `stop()` with no arguments waits for all workers to finish their active jobs before it resolves. It emits a `stopped` event if needed.

A job that a worker is still claiming when you call `stop()` gets its handler if it's ready to start within the timeout, like any active job. For a [`transactional`](./workers.md#work-name-options-handler) worker, ready includes opening its transaction. A job that isn't ready when the timeout runs out is failed without starting its handler. That spends an attempt like any failure (with retries left it goes to `retry`). `stop()` waits for that failure to settle, which can extend shutdown past the timeout. With `graceful: false`, such a job is failed at once.

**Arguments**

* `options`: object

  * `graceful`, bool

    Default: `true`. If `true`, the PgBoss instance waits for any workers processing jobs to finish, up to the timeout. During that time, workers stop fetching, and active jobs and any still being claimed can finish.

  * `close`, bool
    Default: `true`. If pg-boss manages the database connection, it closes the connection pool. Use `false` to keep running operations such as `send()` and `fetch()`. Calling `stop()` again later closes the pool, and from then on those operations reject with `Database not opened`.

    That later close happens once. If it rejects, the pool stays as the driver leaves it, and a further `stop()` has nothing to retry. So treat a `stop()` that throws as terminal for that instance, and don't call it again.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) that active handlers get to finish before pg-boss fails and aborts their jobs. Shutdown still waits for pending claims and database cleanup before it completes.

    The same timeout bounds a [BAM](#getbamstatus) command that is still running. `stop()` waits for the command first and starts the handlers' timeout after it, so a stop that waits on both can take up to twice `timeout`. With `graceful: false` the command is ended at once. What happens to the command depends on what it is:

    - A concurrent index build or drop on PostgreSQL keeps running on the server after its connection is closed. Its row stays `in_progress` until the build ends, and then the next instance with `migrate` enabled marks it completed, or rebuilds the index if the build failed.
    - Any other command, such as a data migration, is canceled and rolls back. Its row is marked `failed`, and the next instance with `migrate` enabled runs it again.
    - On CockroachDB the connection is closed. A schema change keeps running as a CockroachDB job, and any other statement is canceled. The row is marked `failed` and runs again.

    With a custom [`db`](./constructor.md#db) adapter, pg-boss has no connection to close. It cancels every command on PostgreSQL, and waits for the command on CockroachDB. To cancel, the connecting role must be allowed to cancel the command's backend. If it isn't, `stop()` emits one `error` and waits for the command.

    > [!WARNING]
    > This option is ignored for handlers when `graceful` is set to `false`.

```js
// graceful shutdown: wait for active jobs to finish (up to the timeout)
await boss.stop()

// stop workers but keep the connection pool open for send() and fetch()
await boss.stop({ close: false })

// ...and close the pool once the rest of the process is done with it
await boss.stop()

// abort active jobs without a grace period, then await database cleanup
await boss.stop({ graceful: false })
```

### `isInstalled()`

Checks whether pg-boss is installed in the configured database.

```js
const installed = await boss.isInstalled()
// true
```

### `schemaVersion()`

Gets the database schema version.

```js
const version = await boss.schemaVersion()
// 36
```

### `supervise(name, options)`

**Arguments**
- `name`: string, optional. Restrict the pass to a single queue. Omit for every queue.
- `options`: object, optional

Runs one maintenance pass now, without waiting for the next background cycle. The pass covers monitoring (backlog warnings, expired and heartbeat-abandoned jobs, cached stats), deletion of jobs past their retention, warning and queue-stat pruning, and the index bloat check.

Passing `name` restricts the pass to that queue's own rows, but the index bloat check works on whole tables. For a queue with `partition: false` (the default), the indexes it would rebuild belong to the shared `job_common` table, which every other unpartitioned queue also uses.

It's the same pass the background supervisor runs on `superviseIntervalSeconds`. Call it directly when you've set `supervise: false` and drive maintenance yourself, or in tests that can't wait for a timer.

One pass runs at a time. A call made while another pass is in flight, from the background supervisor or an earlier `supervise()`, waits for it to finish, and `stop()` waits for the call. After `stop()`, it resolves without running.

```js
await boss.supervise()
await boss.supervise('email-queue')
```

**Options**

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `reindex` | bool \| object | the instance's [`reindex`](./constructor.md#reindex) setting | Overrides index rebuilding for this pass only |

The `reindex` object accepts the same `minPages`, `maxEntriesPerPage` and `maxIndexBytes` thresholds as the constructor option, plus `force`:

```js
// skip the bloat check and the shared interval, and rebuild every job index now
await boss.supervise(undefined, { reindex: { force: true } })

// run maintenance without touching indexes
await boss.supervise(undefined, { reindex: false })
```

Each step in a pass is rate-limited by its own interval (`maintenanceIntervalSeconds`, `monitorIntervalSeconds`, `reindexIntervalSeconds`). Those limits are shared across instances, so calling `supervise()` in a loop doesn't run everything on every call. The one exception is `reindex: { force: true }`, which skips the interval as well as the bloat check.

### `getReindexCommands(options)`

**Arguments**
- `options`: object, optional. Accepts `force`, `minPages`, `maxEntriesPerPage`, `minSizeRatio`, and `maxIndexBytes`.

Returns the SQL statements that would rebuild the currently bloated job indexes, in the order to run them. They include a `DROP INDEX CONCURRENTLY` for any invalid stub that an interrupted rebuild left behind.

Use it where pg-boss can't run the rebuild itself, because the connected role doesn't own the indexes or the `db` adapter wraps queries in a transaction (`REINDEX CONCURRENTLY` can't run inside one). Returns an empty array on CockroachDB, which has no btree bloat to reclaim and rejects `REINDEX` in any form. Unlike the background pass, it applies no ownership filter, and no size cap unless you pass `maxIndexBytes`, because an operator may run the commands as a different role.

```js
const commands = await boss.getReindexCommands()
// [
//   'REINDEX INDEX CONCURRENTLY pgboss."job_common_i11"',
//   'REINDEX INDEX CONCURRENTLY pgboss."job_common_pkey"'
// ]
```

An empty array means nothing is bloated. Pass `{ force: true }` for every job index instead of only the bloated ones.

> Each statement must be run outside a transaction block.

### `isMaintaining()`

Returns `true` while a maintenance pass is in flight, whether the background supervisor or `supervise()` started it.

```js
const busy = boss.isMaintaining()
// false
```

### `isBamWorking()`

Returns `true` while a boss async migration (BAM) command is running. See [`getBamStatus()`](#getbamstatus).

### `isResolvingFlow()`

Returns `true` while a flow-resolution pass is unblocking dependents of completed parent jobs, whether the background resolver or [`resolveFlow()`](./jobs.md#resolveflow) started it.

### `isCheckingSkew()`

Returns `true` while the clock skew check is running. It only applies when `schedule` is enabled.

### `isTimekeeping()`

Returns `true` while a cron pass is in flight. It only applies when `schedule` is enabled.

### `getDb()`

Returns the database interface this instance uses, which is either the `db` adapter passed to the constructor or the connection pool pg-boss created for itself.

With a [`TestClock`](./testing.md#controlling-time) as the `clock` option, it returns a wrapper around that adapter or pool which counts the statements in flight, so `tick` and `setTime` wait for queries run through it.

```js
const db = boss.getDb()
const { rows } = await db.executeSql('SELECT now()')
```

> Changing pg-boss tables directly, outside the API, isn't supported. `getDb()` is there so an application can run its own queries on the same pool without opening a second one.

### `getInstances(options)`

Returns the pg-boss instances registered in this database, oldest first. `options.limit` sets the most it returns, from 1 to 100,000, and defaults to 1000. Pass the last instance's `id` as `options.after` to read the next page. It rejects if that instance has been deleted since. Each instance registers at `start()` unless constructed with `registerInstance: false`, refreshes its row every [`instanceHeartbeatSeconds`](./constructor.md#instanceheartbeatseconds), and marks it stopped on `stop()`. A process that crashes never marks itself stopped, so its row goes quiet instead, and `live` turns false once it has missed three heartbeats. Maintenance deletes rows whose heartbeat hasn't moved for 7 days.

Every `start()` of a new `PgBoss` object is a new row. So a crash loop, or a deploy whose processes exit without calling `stop()`, leaves a quiet row per life. To keep that bounded, an instance that registers deletes all but the 20 newest stopped or quiet rows with its name (or with its host, when it has no name). Maintenance keeps the 1,000 newest stopped or quiet rows in all. Calling `stop()` on `SIGTERM` marks a row stopped rather than quiet, which tells a deploy apart from a crash. `crashRestarts` survives that pruning.

A life counts toward `crashRestarts` once it's quiet, and only if its last heartbeat came before this instance started. So a sibling process with the same name on the same host (a pm2 cluster, say) isn't counted while it keeps running. A sibling that crashes is counted. The count is kept per name and host, so siblings sharing a name share one count. Give each sibling its own `instanceName` (`worker-1`, `worker-2`) to count them apart. A crash moments before a restart is counted when it goes quiet, up to three heartbeats after `start()`. A process that reuses the previous one's pid, as a container restart does, is counted at once.

```js
const instances = await boss.getInstances()
const working = instances.filter(i => i.live && i.workers.some(w => w.queue === 'emails'))
```

Only instances on pg-boss 12.36 or later register. Older ones, and any constructed with `registerInstance: false`, name their connections `pgboss` in `pg_stat_activity`, where registered ones use `pgboss:` and the start of their id.

**Returns**

Array of objects with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `id` | string | Random at construction, kept across `stop()` and `start()` |
| `name` | string \| null | The [`instanceName`](./constructor.md#instancename) option |
| `host`, `pid` | string, number | `os.hostname()` and the process id |
| `version`, `nodeVersion` | string | pg-boss and Node.js versions |
| `applicationName` | string \| null | The `application_name` of its connections, for joining `pg_stat_activity` |
| `heartbeatSeconds` | number | Its heartbeat interval |
| `supervise`, `schedule`, `migrate`, `persistQueueStats`, `persistWarnings` | boolean | Its constructor options |
| `poolMax`, `poolTotal`, `poolIdle`, `poolWaiting` | number \| null | Its pool at the last heartbeat; null for a `db` adapter |
| `workers` | array | One entry per `work()` call, below |
| `metrics` | object \| null | Its process's CPU, memory and event loop at the last heartbeat, below |
| `config` | object | The options it runs with, for comparing instances: `adapter` (`pg`, or `custom` for a `db` adapter), `backend`, `max`, the roles, every interval and retention setting, and `useListenNotify`. Each holds the value it resolved to, defaults included; an option with no default that was not given is absent. Connection settings and credentials are never recorded. Also `startAttempt`, the [`start({ attempts })`](#start-options) try it registered on, when that was not the first |
| `crashRestarts` | number | Lives in a row with this name on this host that ended without `stop()` before this one started |
| `crashRestartsSince` | Date \| null | When the first of those went quiet |
| `startedOn`, `heartbeatOn` | Date | When it started, and its last heartbeat |
| `stoppedOn` | Date \| null | Set by `stop()` |
| `live` | boolean | Not stopped, and heard from within three heartbeats |

Each `workers` entry has `id` (the id `work()` returned), `queue`, `localConcurrency`, `batchSize`, `pollingIntervalSeconds`, `active` (jobs in hand at the heartbeat), `lastFetchedOn`, `lastJobEndedOn` and `lastErrorOn` as ISO strings or null, and `options`. `options` holds the other `work()` options the call set (`includeMetadata`, `ignoreStartAfter`, `minPriority`, `maxPriority`, `localGroupConcurrency`, `groupConcurrency`, `heartbeatRefreshSeconds`, `perJobResults`, `transactional`, `transactionTimeoutSeconds`, `notifyPollingIntervalSeconds`, `burstWhenReadyExceeds`, `burstWhenBatchFull`), leaving out any left at its default. Error messages are not stored, since they can carry job data.

`metrics` is sampled on each heartbeat. Rates cover the time since the previous heartbeat, so they are null in the row written at `start()`.

| Property | Type | Description |
| --- | --- | --- |
| `cgroup` | 1 \| 2 \| null | The cgroup version its limits were read from, or null when they are the host's |
| `cpu` | number \| null | CPU cores this process used |
| `cpuLimit` | number | Cores it may use: its container's CPU quota, capped at the CPUs it may run on |
| `cpuThrottled` | number \| null | Share of CPU periods its container was paused for reaching its quota, 0 to 1; null without a quota |
| `rss`, `heapUsed`, `heapLimit` | number \| null | Resident set size and V8 heap, in bytes |
| `memoryUsed` | number \| null | Its container's working set in bytes (memory in use less inactive file cache, as container runtimes count it); null without a memory limit |
| `memoryLimit` | number | Its container's memory limit in bytes, or the host's total memory |
| `loopDelay`, `loopDelayMax` | number \| null | Event loop delay in milliseconds, p99 and max |
| `loopUtilization` | number \| null | Share of the time the event loop was busy, 0 to 1 |

Limits come from the cgroup the process is charged to (v1 or v2, with a private or host cgroup namespace), including limits set on a parent such as a Kubernetes pod. pg-boss doesn't use the host-wide figures Node reports in a container. `os.totalmem()`, `os.freemem()`, `os.loadavg()` and `os.cpus()` describe the machine, and `os.availableParallelism()` ignores a CPU quota under one core. Off Linux, or where the cgroup files can't be read, the limits are the host's and the container-only figures are null. A figure the runtime can't provide is null. Bun, for example, has no event loop utilization.

### `getBamStatus()`

Returns a summary of boss async migration (BAM) commands grouped by status.

BAM commands are database operations, such as index builds, that run asynchronously after schema migrations, so an upgrade doesn't wait for them. Once the worker finds a command, it runs the pending ones back to back, without waiting `bamIntervalSeconds` between them. Commands from one migration on one table run in order, and each waits until the one before it has completed. So a failed command holds the ones after it until a retry succeeds. `getBamStatus()` gives an overview of their progress.

```js
const status = await boss.getBamStatus()
// [
//   { status: 'completed', count: 5, lastCreatedOn: 2024-01-15T10:30:00.000Z },
//   { status: 'pending', count: 2, lastCreatedOn: 2024-01-15T10:31:00.000Z }
// ]
```

**Returns**

Array of objects with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `status` | string | One of: `pending`, `in_progress`, `completed`, `failed` |
| `count` | number | Number of BAM entries with this status |
| `lastCreatedOn` | Date | Most recent creation timestamp for this status |

### `getBamEntries(options)`

Returns boss async migration (BAM) command entries with full details, oldest version first. `options.limit` sets the most it returns, from 1 to 100,000, and defaults to 1000. Pass the last entry's `id` as `options.after` to read the next page. It rejects if that entry has been deleted since.

Use it to inspect individual BAM commands, troubleshoot failures, or review the command history.

```js
const entries = await boss.getBamEntries()
// [
//   {
//     id: '550e8400-e29b-41d4-a716-446655440000',
//     name: 'create-index',
//     version: 27,
//     status: 'completed',
//     queue: 'my-queue',
//     table: 'j1a2b3c4...',
//     command: 'CREATE INDEX ...',
//     error: null,
//     createdOn: 2024-01-15T10:30:00.000Z,
//     startedOn: 2024-01-15T10:30:01.000Z,
//     completedOn: 2024-01-15T10:30:05.000Z
//   }
// ]
```

**Returns**

Array of objects with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `id` | string | Unique identifier for the BAM entry |
| `name` | string | Name of the migration command |
| `version` | number | Schema version that created this command |
| `status` | string | One of: `pending`, `in_progress`, `completed`, `failed` |
| `queue` | string | Queue name (if applicable) |
| `table` | string | Target table name |
| `command` | string | SQL command to execute |
| `error` | string | Error message (if failed) |
| `createdOn` | Date | When the entry was created |
| `startedOn` | Date | When execution started |
| `completedOn` | Date | When execution completed |

### `detectSchemaDrift()`

Compares what pg-boss installed against what the database actually has: tables, indexes, functions, columns, constraints, and the `job_state` enum. It reports anything that diverged, such as a manual schema change, a failed migration, or an index left `INVALID` by an interrupted build.

The scan reads only the catalog, so it takes no locks and scans no tables. Presence checks cover every managed table, including `job_common` and each per-queue partition. Those are the checks on tables, indexes, column names, functions and the enum. Default, type, nullability and constraint checks cover only the fixed tables (version, queue, schedule, subscription, bam, warning, queue_stats, job_dependency, instance). On the job tables, the `DEFERRABLE` foreign keys and the interval-typed `keep_until` default would report false positives. A check that needs `pg_get_functiondef`/`pg_get_constraintdef` is skipped where a backend lacks it. CockroachDB skips the type, default and constraint checks entirely, since its `INT8` typing and constraint rendering diverge from standard Postgres. The presence checks still run there.

An index altered so its definition no longer matches is flagged under `mismatched`, with the expected `definition` and the current `actualDefinition` side by side. Here `job_common_i9`'s predicate was changed from `state = 'completed'` to `state = 'active'`:

```js
const report = await boss.detectSchemaDrift()
// {
//   ok: false,
//   missingTables: [],        // e.g. ['warning'], an expected managed table is absent
//   missing: [],
//   building: [],
//   invalid: [],
//   extraIndexes: [],       // warning only, e.g. [{ name: 'job_custom_idx', table: 'job_common' }]
//   mismatched: [
//     {
//       name: 'job_common_i9',
//       table: 'job_common',
//       differs: ['predicate'],
//       // the correct statement vs. what is actually in the catalog
//       definition:       "CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'completed')",
//       actualDefinition: "CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'active')",
//       expectedPredicate: "blocking AND (state = 'completed')",
//       actualPredicate: "blocking AND (state = 'active')",
//       expectedKeys: 'name, id',
//       actualKeys: 'name, id'
//     }
//   ],
//   missingFunctions: [],
//   mismatchedFunctions: [],  // e.g. { name: 'create_queue', expectedBody, actualBody, definition, actualDefinition }
//   columnDrift: [],          // e.g. { table: 'queue', missingColumns: [], unexpectedColumns: ['legacy_flag'],
//                             //        defaultMismatches: [{ column: 'notify', expected: 'false', actual: 'true' }],
//                             //        typeMismatches: [{ column: 'retry_limit', expected: 'integer', actual: 'bigint' }],
//                             //        nullabilityMismatches: [{ column: 'policy', expected: true, actual: false }] }
//   constraintDrift: [],      // e.g. { table: 'queue', missingConstraints: ['CHECK ((dead_letter IS DISTINCT FROM name))'],
//                             //        unexpectedConstraints: [] }
//   enumDrift: null           // or { name: 'job_state', expectedValues: [...], actualValues: [...] }
// }
```

Every entry carries the `definition` that repairs it, which is the full schema-qualified statement, ready to run. `mismatched` entries add `actualDefinition` for a side-by-side read. `invalid` and `missing` entries have nothing to put beside it. An invalid index already *has* the right definition, because an interrupted build left it, and a missing one has no catalog entry at all.

Comparison is normalized throughout, so only a real difference is reported. Index keys are order-significant but insensitive to casing, casts, parentheses and whitespace. A function body is compared whitespace-normalized, so re-indentation alone is never drift. A column default is compared with its casts folded (`'pending'::text` matches `'pending'`), and a type in its canonical `format_type` spelling (`int` matches `integer`; `bigint` does not). Constraints compare as a normalized set of definitions. A primary-key column counts as NOT NULL. Enum order *is* significant, because state comparisons depend on the enum's numeric base type. To make the printed definitions easier to read, pg-boss removes the default `USING btree`, the outer parentheses pg wraps a predicate in, and the casts it adds to every literal.

**Returns**

An object with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `ok` | boolean | `true` when nothing differs across tables, indexes, functions, columns, defaults, types, constraints, or enum |
| `missingTables` | array | Expected managed tables with no matching catalog table |
| `missing` | array | Expected indexes with no matching catalog entry (excludes any a BAM row is still building) |
| `building` | array | Expected indexes still being built by a pending/in&#95;progress/failed BAM row, so not yet drift |
| `invalid` | array | Present indexes marked `INVALID` by an interrupted `CREATE INDEX CONCURRENTLY` (each has a `building` flag) |
| `extraIndexes` | array | **Warning, not drift** (does not affect `ok`). Standalone (non-constraint-backing) indexes present on a managed table that aren't expected, either a stale pg-boss index or one you added. Each has `name`, `table` |
| `mismatched` | array | Present indexes whose key columns/order or predicate differ from the expected definition |
| `missingFunctions` | array | Expected managed functions with no catalog entry |
| `mismatchedFunctions` | array | Present managed functions whose body differs from the expected definition |
| `columnDrift` | array | Managed tables with column drift (each has `table`, `missingColumns`, `unexpectedColumns`, `defaultMismatches`, `typeMismatches`, and `nullabilityMismatches`); only tables that differ are listed. Default/type/nullability checks cover the fixed tables only |
| `constraintDrift` | array | Fixed tables whose constraint set differs (each has `table`, `missingConstraints`, `unexpectedConstraints`); only tables that differ are listed |
| `enumDrift` | object \| null | Set when the `job_state` value set or order differs; `null` when it matches |

Each index entry carries at least `name`, `table`, the readable `keys` and `predicate` it was matched against, and `definition`. `invalid` entries add a `building` flag; `mismatched` entries add `actualDefinition`, `expectedKeys`/`actualKeys`, `expectedPredicate`/`actualPredicate`, and `differs` (`['keys']`, `['predicate']`, or both).

The [`doctor`](../cli#doctor) CLI command runs this same check without writing any application code.

**Remediation**

`detectSchemaDrift()` only reports. It never modifies the schema. `start()` and `migrate` rebuild indexes *only* as part of a version change, so on a schema that's already at the latest version they won't repair drift. The fixes below are manual. Run `DROP`/`CREATE INDEX` with `CONCURRENTLY` on a live database so job processing isn't blocked.

| Category | What it means | How to fix |
| --- | --- | --- |
| `missingTables` | An expected managed table is absent | Restore it, usually by running the schema migration for the version that adds it (or restore from backup). |
| `building` | An async index build is still in progress | No action. Re-check later, and `getBamStatus()` shows build progress. |
| `invalid` | An interrupted build left the index `INVALID` (the definition is correct) | If `building` is `true` (or `getBamStatus()` shows a `pending`/`failed` row for it), it heals on the next `start()`. Otherwise `DROP INDEX CONCURRENTLY <schema>.<name>` and re-run the entry's `definition`. |
| `missing` | An expected index is absent | Run the entry's `definition`. A restart alone will not, since the schema is already current. |
| `mismatched` | A present index diverges from the expected `keys` or `predicate` | Drop the divergent index (`actualDefinition` shows it) and run the entry's `definition` to recreate it. |
| `extraIndexes` | A standalone index on a managed table that pg-boss doesn't expect, either a stale pg-boss index (e.g. after a queue's policy changed) or one you added. Informational; never fails the check | Harmless (extra space only). `DROP INDEX CONCURRENTLY` if it is a stale pg-boss index; otherwise leave your own indexes in place. |
| `missingFunctions` | An expected managed function is absent | Run the entry's `definition` (`CREATE FUNCTION …`) to recreate it. |
| `mismatchedFunctions` | A present function's body was altered | Re-run the entry's `definition` as `CREATE OR REPLACE FUNCTION …` to restore it. |
| `columnDrift` | A managed table has a missing/unexpected column, or a changed default, type, or nullability | Restore a `missingColumns` entry with `ALTER TABLE … ADD COLUMN`; investigate an `unexpectedColumns` entry before dropping it (it may be one you added); fix a `defaultMismatches` entry with `ALTER TABLE … ALTER COLUMN … SET DEFAULT <expected>`, a `typeMismatches` entry with `ALTER COLUMN … TYPE <expected>`, and a `nullabilityMismatches` entry with `ALTER COLUMN … SET/DROP NOT NULL`. |
| `constraintDrift` | A fixed table's constraint set differs | Recreate a `missingConstraints` entry with `ALTER TABLE … ADD <constraint def>`; investigate an `unexpectedConstraints` entry before `DROP CONSTRAINT` (it may be one you added). |
| `enumDrift` | The `job_state` value set or order was changed | Reverting a manual `ALTER TYPE` is not straightforward; recreating the type is risky on a live schema. Restore from backup or open an issue if you did not change it. |

`pg-boss doctor` prints the same `definition` (and `actualDefinition`) beneath each drifted entry.
