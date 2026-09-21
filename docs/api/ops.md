# Operations

### `start()`

Returns the same PgBoss instance used during invocation

Prepares the target database and begins job monitoring.

```js
await boss.start()
await boss.send('hey-there', { msg:'this came for you' })
```

If the required database objects do not exist in the specified database, **`start()` will automatically create them**. The same process is true for updates as well. If a new schema version is required, pg-boss will automatically migrate the internal storage to the latest installed version.

> [!WARNING]
> While this is most likely a welcome feature, be aware of this during upgrades since this could delay the promise resolution by however long the migration script takes to run against your data.  For example, if you happened to have millions of jobs in the job table just hanging around for archiving and the next version of the schema had a couple of new indexes, it may take a few seconds before `start()` resolves. Most migrations are very quick, however, and are designed with performance in mind.

Additionally, all schema operations, both first-time provisioning and migrations, are nested within advisory locks to prevent race conditions during `start()`. Internally, these locks are created using `pg_advisory_xact_lock()` which auto-unlock at the end of the transaction and don't require a persistent session or the need to issue an unlock. For databases that don't support advisory locks (like CockroachDB), select the matching backend (e.g. `backend: 'cockroachdb'`) and pg-boss adjusts accordingly.

One example of how this is useful would be including `start()` inside the bootstrapping of a pod in a ReplicaSet in Kubernetes. Being able to scale up your job processing using a container orchestration tool like k8s is becoming more and more popular, and pg-boss can be dropped into this system without any special startup handling.

### `stop(options)`

Stops all background processing, such as maintenance and scheduling, as well as all polling workers started with `work()`.

By default, calling `stop()` without any arguments will gracefully wait for all workers to finish processing active jobs before resolving. Emits a `stopped` event if needed.

**Arguments**

* `options`: object

  * `graceful`, bool

    Default: `true`. If `true`, the PgBoss instance will wait for any workers that are currently processing jobs to finish, up to the specified timeout. During this period, new jobs will not be processed, but active jobs will be allowed to finish.

  * `close`, bool
    Default: `true`. If the database connection is managed by pg-boss, it will close the connection pool. Use `false` if needed to continue allowing operations such as `send()` and `fetch()`. Calling `stop()` again later closes the pool, and from then on those operations reject with `Database not opened`.

    That later close happens once. If it rejects, the pool is left as the driver leaves it and a further `stop()` has nothing to retry, so treat a `stop()` that throws as terminal for that instance rather than calling it again.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the PgBoss instance.

    > [!WARNING]
    > This option is ignored when `graceful` is set to `false`.

```js
// graceful shutdown: wait for active jobs to finish (up to the timeout)
await boss.stop()

// stop workers but keep the connection pool open for send() and fetch()
await boss.stop({ close: false })

// ...and close the pool once the rest of the process is done with it
await boss.stop()

// shut down immediately without waiting for active jobs
await boss.stop({ graceful: false })
```

### `isInstalled()`

Utility function to see if pg-boss is installed in the configured database.

```js
const installed = await boss.isInstalled()
// true
```

### `schemaVersion()`

Utility function to get the database schema version.

```js
const version = await boss.schemaVersion()
// 36
```

### `supervise(name, options)`

**Arguments**
- `name`: string, optional. Restrict the pass to a single queue. Omit for every queue.
- `options`: object, optional

Runs one maintenance pass immediately instead of waiting for the next background cycle: monitoring (backlog warnings, expired and heartbeat-abandoned jobs, cached stats), deletion of jobs past their retention, warning and queue-stat pruning, and the index bloat check.

Passing `name` restricts the pass to that queue's own rows, but the index bloat check works on tables: for a queue with `partition: false` (the default) the indexes it would rebuild belong to the shared `job_common` table, which every other unpartitioned queue also uses.

This is the same pass the background supervisor runs on `superviseIntervalSeconds`. Call it directly when you have set `supervise: false` and drive maintenance yourself, or in tests where waiting for a timer is not an option.

```js
await boss.supervise()
await boss.supervise('email-queue')
```

**Options**

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `reindex` | bool \| object | the instance's [`reindex`](./constructor.md) setting | Overrides index rebuilding for this pass only |

The `reindex` object accepts the same `minPages`, `maxEntriesPerPage` and `maxIndexBytes` thresholds as the constructor option, plus `force`:

```js
// skip the bloat check and the shared interval, and rebuild every job index now
await boss.supervise(undefined, { reindex: { force: true } })

// run maintenance without touching indexes
await boss.supervise(undefined, { reindex: false })
```

Steps within a pass are individually rate-limited by their own intervals (`maintenanceIntervalSeconds`, `monitorIntervalSeconds`, `reindexIntervalSeconds`), and those limits are shared across instances, so calling `supervise()` in a loop does not run everything on every call. `reindex: { force: true }` is the one exception: it bypasses the interval as well as the bloat check.

### `getReindexCommands(options)`

**Arguments**
- `options`: object, optional. Accepts `force`, `minPages`, `maxEntriesPerPage`, `minSizeRatio`, and `maxIndexBytes`.

Returns the SQL statements that would rebuild the currently bloated job indexes, in the order they should be run, including a `DROP INDEX CONCURRENTLY` for any invalid stub left behind by an interrupted rebuild.

Use this where pg-boss cannot run the rebuild itself, because the connected role does not own the indexes or the `db` adapter wraps queries in a transaction (`REINDEX CONCURRENTLY` cannot run inside one). Returns an empty array on CockroachDB and YugabyteDB, which have no btree bloat to reclaim and reject `REINDEX` in any form. Unlike the background pass, no ownership filter and no size cap are applied unless `maxIndexBytes` is passed, since the commands are intended for an operator who may run them as a different role.

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

Returns `true` while a maintenance pass is in flight, whether started by the background supervisor or by `supervise()`.

```js
const busy = boss.isMaintaining()
// false
```

### `isBamWorking()`

Returns `true` while a boss async migration (BAM) command is being processed. See [`getBamStatus()`](#getbamstatus).

### `isResolvingFlow()`

Returns `true` while the background flow resolver is unblocking dependents of completed parent jobs. See [`resolveFlow()`](./jobs.md#resolveflow).

### `isCheckingSkew()`

Returns `true` while the clock skew check is running. Only relevant when `schedule` is enabled.

### `getDb()`

Returns the database interface this instance is using: the `db` adapter passed in the constructor, or the connection pool pg-boss created for itself.

```js
const db = boss.getDb()
const { rows } = await db.executeSql('SELECT now()')
```

> Reaching past the API and mutating pg-boss tables directly is not supported. This exists so an application can reuse the same pool for its own queries rather than opening a second one.

### `getBamStatus()`

Returns a summary of boss async migration (BAM) commands grouped by status.

BAM commands are database operations that run asynchronously after schema migrations, such as creating indexes on partitioned tables. This function provides a high-level overview of their progress.

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

### `getBamEntries()`

Returns all boss async migration (BAM) command entries with full details.

Use this function when you need to inspect individual BAM commands, troubleshoot failures, or review the command history.

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

Compares what pg-boss installed against what the database actually has: tables, indexes, functions, columns, constraints, and the `job_state` enum. It reports anything that diverged, such as a manual schema change, a failed migration, an index left `INVALID` by an interrupted build.

The scan is catalog-only, so no locks and no table scans. Presence checks cover every managed table, including `job_common` and each per-queue partition. Those are the checks on tables, indexes, column names, functions and the enum. Default, type, nullability and constraint checks are limited to the fixed tables (version, queue, schedule, subscription, bam, warning, queue_stats, job_dependency), since the job tables' `DEFERRABLE` foreign keys and interval-typed `keep_until` default would false-positive. Anything needing `pg_get_functiondef`/`pg_get_constraintdef` is skipped where a backend lacks it, and CockroachDB skips the type, default and constraint checks entirely, since its `INT8` typing and constraint rendering diverge from standard Postgres. The presence checks stay active there.

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

Every entry carries the `definition` that repairs it, which is the full schema-qualified statement, ready to run. `mismatched` entries add `actualDefinition` for a side-by-side read. `invalid` and `missing` entries have nothing to put beside it: an invalid index already *has* the right definition (an interrupted build, not a wrong shape), and a missing one has no catalog entry at all.

Comparison is normalized throughout, so only a real difference is reported. Index keys are order-significant but insensitive to casing, casts, parentheses and whitespace. A function body is compared whitespace-normalized, so re-indentation alone is never drift. A column default is compared with its casts folded (`'pending'::text` matches `'pending'`) and a type in its canonical `format_type` spelling (`int` matches `integer`; `bigint` does not), and constraints compare as a normalized set of definitions. A primary-key column counts as NOT NULL. Enum order *is* significant, since the enum's numeric base type makes it load-bearing for state comparisons. What gets printed is tidied for reading: the default `USING btree`, the outer parentheses pg wraps a predicate in, and the casts it adds to every literal are all removed.

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

`detectSchemaDrift()` only reports. It never modifies the schema. Note that `start()` and `migrate` rebuild indexes *only* as part of a version change, so on a schema that is already at the latest version they will not repair drift; the fixes below are manual. Run `DROP`/`CREATE INDEX` with `CONCURRENTLY` on a live database so job processing is not blocked.

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
