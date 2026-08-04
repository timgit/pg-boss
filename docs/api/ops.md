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
    Default: `true`. If the database connection is managed by pg-boss, it will close the connection pool. Use `false` if needed to continue allowing operations such as `send()` and `fetch()`.

  * `timeout`, int

    Default: 30000. Maximum time (in milliseconds) to wait for workers to finish job processing before shutting down the PgBoss instance.

    > [!WARNING]
    > This option is ignored when `graceful` is set to `false`.

```js
// graceful shutdown: wait for active jobs to finish (up to the timeout)
await boss.stop()

// stop workers but keep the connection pool open for send() and fetch()
await boss.stop({ close: false })

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

Compares the managed tables, indexes, functions, table columns (name, default, type, and nullability), table constraints, and the `job_state` enum pg-boss expects against what actually exists in the database and reports any drift. Use it to catch tables that were dropped; indexes that were dropped, left `INVALID` by an interrupted build, or altered; functions whose body was changed (e.g. a manual `CREATE OR REPLACE`); table columns that were added or dropped; column defaults, data types, or NOT NULL flags that were changed; primary-key/foreign-key/check constraints that were dropped or added; and enum values that were added or reordered — anything that diverged from the version pg-boss installed, for example after a manual schema change or a failed migration.

The scan is catalog-only (no locks, no table scans) and includes partial-index predicates. Partitioned vs. non-partitioned and per-queue policy indexes are read from the live database, since partitioned tables have conditional indexes. Table presence and column *name* drift (a missing or unexpected column) cover job_common and every per-queue partition alongside the fixed tables. Column *default*, *type*, and *nullability* drift and *constraint* drift are limited to the fixed tables (version, queue, schedule, subscription, bam, warning, queue_stats, job_dependency) — the job/job_common/partition tables are excluded because their foreign keys are `DEFERRABLE` under some backend profiles and their `keep_until` default renders as a non-comparable interval literal, both of which would false-positive. Function-body, constraint, and enum checks are best-effort: on backends without `pg_get_functiondef`/`pg_get_constraintdef` (e.g. CockroachDB) they are skipped rather than reported as drift. On CockroachDB the type/default/constraint checks are skipped entirely — its `INT8` typing, default rendering, and constraint definitions diverge from standard Postgres — leaving the presence checks (tables, indexes, column names, functions, enum) active.

For example, when an index has been altered so its definition no longer matches — here `job_common_i9`'s predicate was changed from `state = 'completed'` to `state = 'active'` — it is flagged under `mismatched`, with the expected `definition` and the current `actualDefinition` side by side:

```js
const report = await boss.detectSchemaDrift()
// {
//   ok: false,
//   missingTables: [],        // e.g. ['warning'] — an expected managed table is absent
//   missing: [],
//   building: [],
//   invalid: [],
//   extraIndexes: [],       // warning only — e.g. [{ name: 'job_custom_idx', table: 'job_common' }]
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

Every drifted index entry carries `definition` — the full, schema-qualified `CREATE INDEX` statement pg-boss expects — so you can copy it to recreate the index. `mismatched` entries also carry `actualDefinition` (from `pg_get_indexdef`) for a direct side-by-side comparison. `invalid` and `missing` entries carry only `definition`: an invalid index already *has* the correct definition (an interrupted build, not a wrong shape), and a missing one has no catalog entry to compare against, so there is nothing meaningful to place beside `definition`.

`extraIndexes` is a **warning, not drift** — a standalone index present on a managed table that isn't in the expected set. pg-boss can't tell a stale index it left behind (e.g. a policy index after a queue's policy changed) from one you added for your own queries, and either is harmless (extra space, never wrong results), so these are reported for visibility but do not make `ok` false. Constraint-backing indexes (`*_pkey`) are excluded — those are covered by the constraint check.

Function drift is reported the same way: `missingFunctions` holds expected functions with no catalog entry, and `mismatchedFunctions` holds present functions whose body differs, each with the expected `definition` and the current `actualDefinition` (from `pg_get_functiondef`). Because Postgres stores a function body verbatim, the comparison is on the body text (whitespace-normalized), so re-indentation alone is never reported as drift. `enumDrift` is `null` when the `job_state` values and their order match, or an object with `expectedValues`/`actualValues` when they diverge (order is significant — the enum's numeric base type makes it load-bearing for state comparisons).

Table presence rides the same report: `missingTables` lists managed tables (fixed tables, plus `job`/`job_common`/partitions in partitioned mode) that the catalog does not have — a dropped table shows up here rather than as a flood of missing columns.

Column-default, type, nullability, and constraint drift ride the same report too. A `columnDrift` entry adds three per-column arrays for the fixed tables: `defaultMismatches` (`{ column, expected, actual }` — compared on a normalized form, so a cast or reformat pg adds like `'pending'::text` vs `'pending'` is not flagged), `typeMismatches` (`{ column, expected, actual }`, where the type is the canonical `format_type` form so `int` vs `integer` is not flagged but `integer` vs `bigint` is), and `nullabilityMismatches` (`{ column, expected, actual }` of booleans — a dropped or added NOT NULL, primary-key columns counted as NOT NULL). `constraintDrift` lists fixed tables whose constraint set differs: `missingConstraints` are the expected `pg_get_constraintdef` statements absent from the catalog, `unexpectedConstraints` the extra ones present. Comparison is a normalized set of definition strings (lower-cased, casts/quotes/whitespace folded), so only a genuinely added or dropped constraint is reported.

**Returns**

An object with the following properties:

| Property | Type | Description |
| --- | --- | --- |
| `ok` | boolean | `true` when nothing differs across tables, indexes, functions, columns, defaults, types, constraints, or enum |
| `missingTables` | array | Expected managed tables with no matching catalog table |
| `missing` | array | Expected indexes with no matching catalog entry (excludes any a BAM row is still building) |
| `building` | array | Expected indexes still being built by a pending/in&#95;progress/failed BAM row — not yet drift |
| `invalid` | array | Present indexes marked `INVALID` by an interrupted `CREATE INDEX CONCURRENTLY` (each has a `building` flag) |
| `extraIndexes` | array | **Warning, not drift** (does not affect `ok`). Standalone (non-constraint-backing) indexes present on a managed table that aren't expected — a stale pg-boss index or one you added. Each has `name`, `table` |
| `mismatched` | array | Present indexes whose key columns/order or predicate differ from the expected definition |
| `missingFunctions` | array | Expected managed functions with no catalog entry |
| `mismatchedFunctions` | array | Present managed functions whose body differs from the expected definition |
| `columnDrift` | array | Managed tables with column drift (each has `table`, `missingColumns`, `unexpectedColumns`, `defaultMismatches`, `typeMismatches`, and `nullabilityMismatches`); only tables that differ are listed. Default/type/nullability checks cover the fixed tables only |
| `constraintDrift` | array | Fixed tables whose constraint set differs (each has `table`, `missingConstraints`, `unexpectedConstraints`); only tables that differ are listed |
| `enumDrift` | object \| null | Set when the `job_state` value set or order differs; `null` when it matches |

Each entry carries at least `name`, `table`, the readable `keys` and `predicate` it was matched against, and `definition` (the full expected `CREATE INDEX`). `invalid` entries add a `building` flag. `mismatched` entries add `actualDefinition` (the current statement from `pg_get_indexdef`), `expectedKeys`/`actualKeys`, `expectedPredicate`/`actualPredicate`, and `differs` (`['keys']`, `['predicate']`, or both). Both the expected and the `actual*` values are rendered from `pg_get_indexdef` (so they line up for a direct side-by-side read), lightly tidied for readability (the default `USING btree` clause, the redundant outer parentheses pg wraps the predicate in, and the type casts pg adds to every literal — e.g. `'active'::pgboss.job_state` reads as `'active'` — are all removed); pg's per-conjunct grouping like `blocking AND (state = 'completed')` is left as-is. Comparison itself is done on a normalized form internally (order-significant, but insensitive to casing, casts, parentheses, and whitespace), so a difference in those alone is never reported as drift.

The [`doctor`](../cli#doctor) CLI command runs this same check without writing any application code.

**Remediation**

`detectSchemaDrift()` only reports — it never modifies the schema. Note that `start()` and `migrate` rebuild indexes *only* as part of a version change, so on a schema that is already at the latest version they will not repair drift; the fixes below are manual. Run `DROP`/`CREATE INDEX` with `CONCURRENTLY` on a live database so job processing is not blocked.

| Category | What it means | How to fix |
| --- | --- | --- |
| `missingTables` | An expected managed table is absent | Restore it — usually by running the schema migration for the version that adds it (or restore from backup). |
| `building` | An async index build is still in progress | No action — re-check later. `getBamStatus()` shows build progress. |
| `invalid` | An interrupted build left the index `INVALID` (the definition is correct) | If `building` is `true` (or `getBamStatus()` shows a `pending`/`failed` row for it), it heals on the next `start()`. Otherwise `DROP INDEX CONCURRENTLY <schema>.<name>` and re-run the entry's `definition`. |
| `missing` | An expected index is absent | Run the entry's `definition` — a restart alone will not, since the schema is already current. |
| `mismatched` | A present index diverges from the expected `keys` or `predicate` | Drop the divergent index (`actualDefinition` shows it) and run the entry's `definition` to recreate it. |
| `extraIndexes` | A standalone index on a managed table that pg-boss doesn't expect — a stale pg-boss index (e.g. after a queue's policy changed) or one you added. Informational; never fails the check | Harmless (extra space only). `DROP INDEX CONCURRENTLY` if it is a stale pg-boss index; otherwise leave your own indexes in place. |
| `missingFunctions` | An expected managed function is absent | Run the entry's `definition` (`CREATE FUNCTION …`) to recreate it. |
| `mismatchedFunctions` | A present function's body was altered | Re-run the entry's `definition` as `CREATE OR REPLACE FUNCTION …` to restore it. |
| `columnDrift` | A managed table has a missing/unexpected column, or a changed default, type, or nullability | Restore a `missingColumns` entry with `ALTER TABLE … ADD COLUMN`; investigate an `unexpectedColumns` entry before dropping it (it may be one you added); fix a `defaultMismatches` entry with `ALTER TABLE … ALTER COLUMN … SET DEFAULT <expected>`, a `typeMismatches` entry with `ALTER COLUMN … TYPE <expected>`, and a `nullabilityMismatches` entry with `ALTER COLUMN … SET/DROP NOT NULL`. |
| `constraintDrift` | A fixed table's constraint set differs | Recreate a `missingConstraints` entry with `ALTER TABLE … ADD <constraint def>`; investigate an `unexpectedConstraints` entry before `DROP CONSTRAINT` (it may be one you added). |
| `enumDrift` | The `job_state` value set or order was changed | Reverting a manual `ALTER TYPE` is not straightforward; recreating the type is risky on a live schema. Restore from backup or open an issue if you did not change it. |

Each `invalid`, `missing`, and `mismatched` index entry includes a ready-to-run `definition` (the complete `CREATE INDEX`, `UNIQUE` and all). When applying it to a live table, insert `CONCURRENTLY` (`CREATE INDEX CONCURRENTLY …`) so it does not block job processing. `missingFunctions`/`mismatchedFunctions` entries carry a `definition` too. `pg-boss doctor` prints the same `definition` (and `actualDefinition`) beneath each drifted entry.
