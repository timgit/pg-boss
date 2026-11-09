# Database backends

pg-boss runs on stock single-node PostgreSQL by default. It also supports several PostgreSQL-compatible backends: distributed SQL engines like CockroachDB and Citus, plus the embedded WASM build [PGlite](https://pglite.dev). The `backend` option selects a backend and applies all the compatibility behavior the backend needs.

## Backend profiles

`backend` is the **only** option you set. It selects the database pg-boss is running against and
turns on the right combination of internal compatibility behavior for that database:

```typescript
import PgBoss from 'pg-boss'

const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  backend: 'cockroachdb'
})
```

Each backend has a *kind*, which is `standard` (stock PostgreSQL), `distributed` (clustered
Postgres-compatible engines), or `embedded` (in-process PostgreSQL).

| `backend` | Kind | What it changes |
|-----------|------|-----------------|
| `postgres` *(default)* | standard | *(none, full PostgreSQL)* |
| `cockroachdb` | distributed | Lock-free fetch, split-statement writes, single shared table, immediate constraints, lock-free schema setup, plain indexes (+ numeric coercion), default-only column adds, no LISTEN/NOTIFY, no heartbeat on transactional workers, no index-bloat or vacuum checks |
| `citus` | distributed | *(none, coordinator-local tables behave like plain PostgreSQL)* |
| `pglite` | embedded | *(none, full PostgreSQL; see [PGlite](#pglite-embedded))* |

Because pg-boss derives everything above from `backend`, a deployment can't end up with an
inconsistent combination. The sections below explain each behavior and name the internal flag it
maps to in the source. Databases without a profile
(Aurora DSQL, Spanner) are **not yet supported**.

## Database compatibility

The matrix shows which PostgreSQL features each backend supports (✅). Where a feature isn't
available (❌), pg-boss automatically switches to the compatible alternative. See the
[compatibility flags](#compatibility-flags) below.

| Database | Status | `backend` | SKIP LOCKED | Multi-mutation CTEs | Table partitioning | Deferrable constraints | Advisory locks | Covering indexes | Writes to a column it just added | LISTEN/NOTIFY |
|----------|--------|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| PostgreSQL | Tested | `postgres` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CockroachDB | Tested | `cockroachdb` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Citus | Tested¹ | `citus` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| PGlite | Tested | `pglite` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅² |

¹ In standard mode (coordinator-local table) Citus supports these features like plain PostgreSQL. A
deliberately sharded job table would lose `SKIP LOCKED` compatibility and need the atomic-`UPDATE`
fetch instead. See [Citus](#tested-citus-compatible-in-standard-mode).

² Because PGlite is embedded single-connection PostgreSQL, LISTEN/NOTIFY works entirely in-process.
`useListenNotify` works with no extra setup, because the `fromPglite` adapter wires it up automatically.

Bun's `Bun.SQL` client has no row of its own, because it's a different *driver* for the same
PostgreSQL database. It runs on the `postgres` profile with every feature above (LISTEN/NOTIFY
needs Bun 1.4.0 or later). See [Bun](#bun-driver).

## Compatibility flags

The table lists what each behavior does differently from stock PostgreSQL, and the internal flag it
maps to in the source.

| Capability | Effect | Trade-off | Flag |
|------------|--------|-----------|------|
| Lock-free fetch | Fetch jobs with an atomic `UPDATE ... RETURNING` (plus a `state < 'active'` recheck) instead of `SELECT FOR UPDATE SKIP LOCKED`. | Under high contention some workers get empty results instead of skipping to unlocked rows. | `noSkipLocked` |
| Split-statement writes | Run `complete`, `fail`, and supervisor expiry as split statements inside a transaction rather than a single multi-mutation CTE. | A few extra round-trips per command, which is negligible for normal workloads. | `noMultiMutationCte` |
| Single shared table | Create the job table without `PARTITION BY LIST`. | Per-queue partitioning (`partition: true`) is unavailable; all jobs share one table. | `noTablePartitioning` |
| Immediate constraints | Omit `DEFERRABLE INITIALLY DEFERRED` on foreign keys. | Constraints check immediately rather than at commit (no effect on normal operation). | `noDeferrableConstraints` |
| Lock-free schema setup | Disable `pg_advisory_xact_lock` (used to coordinate schema creation/migration). | Concurrent instances may occasionally repeat maintenance work, which costs time but leaves the results correct. | `noAdvisoryLocks` |
| Plain indexes | Omit the `INCLUDE` clause on covering indexes. | Index-only scans during fetch are slightly less efficient. The difference is minimal for most workloads. | `noCoveringIndexes` |
| Default-only column adds | Leave out the `UPDATE` that seeds a column the same migration added, for engines that refuse to write a column in the transaction that added it. | Rows carry the column's default until something rewrites them. For example, after v41 a schedule holding an RRULE reads as `cron` from `getSchedules()` until the next scheduling pass relabels it. | `noAddColumnBackfill` |
| No transactional heartbeat | Refuse a [`transactional`](./api/workers.md#work-name-options-handler) worker on a queue with `heartbeatSeconds` set, for engines that will not let a transaction write a row another session wrote after it began. | The two cannot be combined on that engine; `expireInSeconds` is the liveness bound for a transactional worker there. | `noTransactionalHeartbeat` |
| No LISTEN/NOTIFY | Leave out the `pg_notify` call on insert and the `useListenNotify` listener, for engines that don't implement LISTEN/NOTIFY. | Workers find jobs by polling. With `useListenNotify` set, `start()` emits a `listen_notify_unavailable` warning. | `noListenNotify` |
| Timeout-only BAM reclaim | Reclaim a stuck `in_progress` [BAM](api/ops#getbamstatus) command on its timeout alone, for engines whose `pg_stat_progress_create_index` doesn't show whether an index build is still running. | A command whose instance died waits out the 24-hour timeout. BAM doesn't drop and rebuild an invalid index. | `noIndexProgressView` |
| No index-bloat pass | Skip the [`reindex`](api/constructor#reindex) maintenance pass, detection included, for engines that store data outside PostgreSQL's heap and reject `REINDEX`. | No `index_bloat` warning, `getReindexCommands()` returns an empty list, and the CLI `reindex` command refuses to run. | `noReindex` |
| No vacuum checks | Skip the [`monitorVacuum`](api/constructor#monitorvacuum) checks, for engines that reclaim rows with their own garbage collection instead of PostgreSQL's vacuum. | No `xmin_horizon`, `autovacuum_disabled` or `monitor_backoff` warning. | `noMonitorVacuum` |
| Inline table indexes | Declare each table's primary key, indexes and constraints inside its `CREATE TABLE` on a fresh install, instead of as statements after it. | None. pg-boss uses inline indexes only after the server reports itself as CockroachDB, because the inline `INDEX` syntax is CockroachDB's. Migrations are unaffected. | `inlineTableIndexes` |

Lock-free fetch, split-statement writes, the transactional-heartbeat refusal, the LISTEN/NOTIFY,
BAM, index-bloat and vacuum changes are **runtime** behaviors; the other six are **schema** choices
applied at install/migration time. CockroachDB needs all thirteen; other distributed engines need
only a subset (see below). CockroachDB also needs text-encoded integers coerced back to numbers,
which pg-boss keys on `backend === 'cockroachdb'` directly instead of on a flag (see below).

### Fetch and mutation strategies

`noSkipLocked` and `noMultiMutationCte` address two unrelated limitations that happen to coincide on
CockroachDB:

- **`noSkipLocked`** is about the *fetch* path. By default pg-boss claims jobs with `SELECT FOR
  UPDATE SKIP LOCKED`. In some distributed engines the statement has two problems:
  1. **Performance degradation under concurrency.** With 500 workers, mean latency for `SELECT FOR
     UPDATE SKIP LOCKED` can reach 311ms or higher ([CockroachDB #97135](https://github.com/cockroachdb/cockroach/issues/97135)).
  2. **Unexpected row skipping.** `SKIP LOCKED` can skip unlocked rows. Workers then miss
     available work ([CockroachDB #121917](https://github.com/cockroachdb/cockroach/issues/121917)).

  With `noSkipLocked`, pg-boss instead claims jobs with an atomic `UPDATE ... RETURNING` and a
  `state < 'active'` recheck:

  ```sql
  WITH next AS (
    SELECT id FROM jobs
    WHERE name = $name
      AND state < 'active'
      AND start_after <= now()
    ORDER BY priority DESC, created_on, id
    LIMIT $batchSize
  )
  UPDATE jobs j SET
    state = 'active',
    started_on = now(),
    retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
  FROM next
  WHERE j.id = next.id
    AND j.state < 'active'  -- recheck for concurrent safety
  RETURNING j.*
  ```

  See [Andrew Werner's article on distributed work queues](https://dev.to/ajwerner/quick-and-easy-exactly-once-distributed-work-queues-using-serializable-transactions-jdp)
  for the pattern. The trade-off shows under high contention, when several workers' CTEs may select
  the same candidate rows and all attempt the `UPDATE`. Only one worker wins the rows. The others
  receive empty results and poll again. The empty results are acceptable when processing time >>
  fetch time, which is typical for job queues.

- **`noMultiMutationCte`** is about the *write* path. pg-boss's `complete`, `fail`, and supervisor
  expiry normally run as a single CTE that mutates the job table more than once (e.g. completing a
  job and unblocking its flow dependents). CockroachDB rejects such a CTE with `multiple mutations of the
  same table "job" are not supported`. With `noMultiMutationCte`, those operations instead run as separate
  statements inside one transaction so that a job can't be lost between them.

pg-boss replaces only `SKIP LOCKED` in the fetch path. Other operations still use ordinary
`SELECT ... FOR UPDATE` (without `SKIP LOCKED`), which distributed engines support fine.

pg-boss handles a third CockroachDB quirk separately. CockroachDB returns integer columns (`INT8`)
as text. pg-boss `Number()`-coerces the numeric job and queue fields on read **whenever `backend ===
'cockroachdb'`**. It keys the coercion on the backend identity instead of a compatibility flag,
because integers as text are a wire-format property of the database. (Stock Postgres returns these
fields as `int4` numbers, which need no coercion.)

### Transaction isolation

SERIALIZABLE isolation is the recommended level for distributed work queues. With
`noSkipLocked`, it ensures no two workers claim the same job. With READ COMMITTED (the PostgreSQL
default), the `state < 'active'` recheck in the `UPDATE` still prevents duplicate claims.

## Per-database notes

The sections below give each supported backend's testing status, setup, and caveats.

### Tested: PostgreSQL

PostgreSQL is the primary supported database with full feature support. Use standard mode, which
needs no special options.

### Tested: CockroachDB

CockroachDB needs every compatibility behavior; the `cockroachdb` profile turns them all on:

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  backend: 'cockroachdb'
})
```

Internally the profile enables atomic-`UPDATE` fetch (`noSkipLocked`), split-statement mutations
(`noMultiMutationCte`), a non-partitioned table (`noTablePartitioning`), non-deferrable constraints
(`noDeferrableConstraints`), no advisory locks (`noAdvisoryLocks`), no covering-index `INCLUDE`
(`noCoveringIndexes`), default-only column adds (`noAddColumnBackfill`), no LISTEN/NOTIFY
(`noListenNotify`), timeout-only BAM reclaim (`noIndexProgressView`), no index-bloat pass
(`noReindex`), no vacuum checks (`noMonitorVacuum`), no heartbeat on transactional workers
(`noTransactionalHeartbeat`), inline table indexes (`inlineTableIndexes`), and numeric coercion on
read. See
[compatibility flags](#compatibility-flags).

**Upgrades on CockroachDB** commit without building indexes on existing tables. The migration queues each
index build as a [BAM](api/ops#getbamstatus) command, which runs after the migration on an instance
with `migrate` enabled. `start()` doesn't wait for the builds. Until a build finishes, queries run without
that index. The migration still builds a unique index that a write depends on, such as the index
behind `upsert()` by key. If [`stop()`](api/ops#stop-options) times out during a build,
pg-boss closes the connection waiting on it and marks the row failed. CockroachDB finishes the build
on its own. An attempt that runs before the build finishes marks the row failed again and emits a
`bam` event but no `error` event. The first attempt after the build finishes completes the row. A
command that isn't a schema change, such as a data migration, is canceled when its connection
closes and then runs again.
If the instance crashes instead, its BAM row is not marked done for up to 24 hours. The commands
queued behind it wait that long.
The [CLI](cli#migrate) runs the same builds directly after the migration.

**Transactional workers on CockroachDB** work, with two differences from PostgreSQL:

- A queue with `heartbeatSeconds` set can't have a transactional worker
  (`noTransactionalHeartbeat`). By design, the heartbeat refreshes `heartbeat_on` on the claimed
  row from a pooled connection so that the job stays visibly `active` while the handler runs. Under
  serializable isolation, the heartbeat write lands above the handler transaction's timestamp.
  CockroachDB then refuses the completion pg-boss runs inside the transaction. `work()` rejects the
  combination, because the worker would fail every batch. Drop `heartbeatSeconds` and let
  `expireInSeconds` bound the job, or drop `transactional` and settle with `complete({ db })`.
  A `heartbeatSeconds` that appears after `work()` has checked the queue gets past that check. The
  setting can come from the job itself, or from the queue through `updateQueue()` or a
  `createQueue()` that `work()` ran ahead of. Each batch that carries the setting then fails before
  its transaction opens. The error names where the setting came from.
- When something takes the claim away mid-handler and the handler then settles the job itself
  through `tx`, that settle comes back as a raw `40001` retry error instead of `affected: 0`. The
  transaction rolls back either way, which keeps the handler's writes from landing beside a job
  that is about to run again. Only the error the job records differs from the message PostgreSQL produces.

**Because `cockroachdb` disables table partitioning:**
- Queue-level partitioning (`partition: true` on `createQueue`) is not supported
- All jobs are stored in a single table instead of per-queue partitions

CockroachDB uses a [different partitioning model](https://www.cockroachlabs.com/docs/stable/partitioning)
that requires partition columns in the PRIMARY KEY and partitions defined inline at table creation.

In `noMultiMutationCte` mode, the supervisor's expiry (`failJobsByTimeout` / `failJobsByHeartbeat`)
uses CockroachDB-safe split statements instead of the multi-mutation `failJobs()` CTE, which
CockroachDB rejects. The supervisor still moves timed-out and heartbeat-timed-out jobs to
`retry`/`failed` instead of leaving them stranded in `active`. Separately, pg-boss coerces numeric
job and queue fields (including `heartbeatSeconds`) back to numbers on read, because CockroachDB
returns integers as text. That coercion is keyed on `backend === 'cockroachdb'` directly.

**Verified on CockroachDB** (full-suite run, PostgreSQL-only tests skipped): job send/fetch,
complete, fail (by id), retry of an explicitly failed job (including exponential backoff and
`retryDelayMax`), maintenance expiration of timed-out jobs (`expireInSeconds`), heartbeat config +
heartbeat-timeout (`heartbeatSeconds`), queue policies (`short`/`singleton`/`stately` with
`partition: false`), throttle/debounce, deferral, cancellation, flow dependency
blocking/unblocking, including a blocking parent that fails and retries, and schema migration to
latest (with rollback on error).

#### Testing the runtime toggles

Because `noSkipLocked` and `noMultiMutationCte` are pure runtime behaviors (no schema impact) that
work on plain PostgreSQL, the project exercises them two ways:

- **`npm run test:distributed`** runs the **entire** test suite on Postgres with
  `DISTRIBUTED=true`, which makes `test/testHelper.ts`'s `getConfig()` set the internal
  `__test__distributed` hook for every test. The hook forces `noSkipLocked` + `noMultiMutationCte`
  on top of the plain-Postgres schema, since no public option sets the flags. This mode is the
  primary safety net, because every new test runs against the distributed code paths without
  paying CockroachDB's slow per-test DDL. It runs as its own CI job.
- **`npm run test:cockroachdb`** runs `test/distributedDatabaseTest.ts` against a real CockroachDB
  cluster (`DB_TYPE=cockroachdb`, which also enables the compatibility flags above). It's a focused
  smoke test of real CockroachDB compatibility and runs on every push/PR.
- **`npm run test:cockroachdb:full`** runs the **entire** suite against a real CockroachDB cluster
  (`--no-file-parallelism`). The full run is the compatibility-matrix / regression signal. Because it isn't
  part of CI, run it before a release or after touching SQL. A fresh schema installs in well under a
  second, because every table's indexes are declared inside its `CREATE TABLE` (see
  `inlineTableIndexes`). The remaining time is CockroachDB's latency on the test bodies themselves. The
  per-test timeout goes up automatically under CockroachDB (see `vitest.config.ts`).
- **`npm run test:cockroachdb:single`** starts a single-node, in-memory CockroachDB
  (`docker-compose.cockroach-single.yaml`) and runs the same full suite against it in about half
  the time the three-node cluster takes. Use it for local iteration; only the three-node cluster
  exercises replication. Because both clusters use the same port, stop the running cluster before starting the other.

For tests that depend on PostgreSQL-only features (table partitioning, covering indexes, or an exact
PostgreSQL schema/migration shape), `test/testHelper.ts` exports `itPostgresOnly` /
`describePostgresOnly`, which skip under CockroachDB. For data-driven tests that loop over
`partition: true`/`false`, narrow the cases with `helper.isCockroachDb`.

`test/distributedDatabaseTest.ts` holds the invariants the general suite cannot express
(concurrent-fetch deduplication, `failDistributed`/`completeDistributed` composition inside a caller
transaction, and the compatibility-flag construction paths). Because those cases force distributed
runtime via `__test__distributed` (or select `backend: 'cockroachdb'` for the schema-construction
case), they run in every mode.

### Tested: Citus (compatible in standard mode)

Citus is a PostgreSQL extension that can shard tables across nodes. Because pg-boss doesn't call
`create_distributed_table()`, its tables stay **local to the coordinator** and behave like plain
PostgreSQL. The **full pg-boss test suite passes** against a single-node Citus coordinator
(`citusdata/citus`, PostgreSQL 18 + Citus 14) with the `citus` extension loaded and **no special
flags**. Partitioning, queue policies, flows, heartbeat, multi-master, and migrations all work.

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://localhost:5434/pgboss',
  backend: 'citus' // standard mode, no flags
})
```

To run the suite yourself, start Citus with `docker compose -f docker-compose.citus.yaml up -d`, then run `npm run test:citus:full`.

**The one caveat is opt-in.** If you deliberately shard the pg-boss job table with
`create_distributed_table()`, `SELECT FOR UPDATE SKIP LOCKED`
[only works for single-shard queries](https://docs.citusdata.com/en/stable/develop/reference_workarounds.html).
A *distributed* job table would then need the CockroachDB-style atomic-`UPDATE` fetch, which the
`citus` profile doesn't enable. There is no profile for sharded Citus today. A **reference table**
(replicated to all nodes) and the default coordinator-local table both work with `backend: 'citus'`.

### PGlite (embedded)

[PGlite](https://pglite.dev) is a complete PostgreSQL build packaged as a WASM library that runs
embedded in your Node.js (or browser) process and needs no separate database server. Because PGlite is real
PostgreSQL, pg-boss runs against it with **no compatibility flags**. Declarative partitioning,
deferrable constraints, advisory locks, covering indexes, `SELECT FOR UPDATE SKIP LOCKED`, and the
multi-statement migration DDL all work. Because PGlite is embedded single-connection PostgreSQL,
it's **not** a distributed backend. pg-boss reaches it through the `@electric-sql/pglite` client and the
`fromPglite` adapter instead of the `pg` connection pool.

#### Usage

Install PGlite alongside pg-boss:

```bash
npm install @electric-sql/pglite
```

Construct a PGlite instance, wrap it with `fromPglite`, and select the `pglite` backend profile:

```ts
import { PGlite } from '@electric-sql/pglite'
import PgBoss, { fromPglite } from 'pg-boss'

const pglite = new PGlite('idb://my-app')   // or new PGlite() for in-memory

const boss = new PgBoss({
  backend: 'pglite',
  db: fromPglite(pglite)
})

await boss.start()

await boss.createQueue('email')
await boss.send('email', { to: 'user@example.com' })

const [job] = await boss.fetch('email')
// ... do work ...
await boss.complete('email', job.id)
```

#### Lifecycle

pg-boss opens and closes its default `pg` pool, but it does **not** open or close a PGlite instance. Because you own the instance, construct it before `boss.start()` and close it after `boss.stop()`:

```ts
await boss.stop()
await pglite.close()
```

As with the [ORM transaction adapters](api/adapters.md), pg-boss only calls `executeSql` on the
object you provide.

#### Single-connection considerations

PGlite serializes everything through one connection. Because pg-boss's background loops
(maintenance, scheduling, monitoring) and your workers all share that single connection, PGlite
processes queries one at a time. One connection is enough because PGlite queues requests internally, but keep
concurrency modest:

- A large `batchSize` or many concurrent workers gain nothing, because they can't run in parallel.
- For embedded / local-first / testing workloads (PGlite's sweet spot) the single connection is rarely a constraint.
- For high-throughput multi-worker queues, use a server-based PostgreSQL instead.

#### Persistence

PGlite supports in-memory, IndexedDB (browser), and filesystem persistence. See the
[PGlite docs](https://pglite.dev/docs/filesystems). pg-boss treats every storage option the same; the job
schema and data persist wherever the PGlite instance stores its data directory.

### Bun (driver)

[Bun](https://bun.sh) ships its own PostgreSQL client, `Bun.SQL`. Because it talks to an ordinary
PostgreSQL server, it needs no backend profile of its own. Every feature works on the default `postgres`
profile. `Bun.SQL` is a different *driver*, which pg-boss reaches through an adapter instead of the
`pg` connection pool.

You don't need an adapter to run pg-boss on Bun, because the bundled `pg` driver works under the Bun runtime
and a connection string is the simpler choice. Use an adapter when you want pg-boss and the rest of
your Bun application to share one client and one pool.

| What you want | Use |
|---|---|
| pg-boss to run on your Bun client | `fromBunSql(sql)` as the constructor `db` |
| To enqueue inside a Drizzle transaction on `bun-sql` | [`fromDrizzle(tx, sql)`](api/adapters.md#drizzle) as the per-call `db` |

#### Running pg-boss on Bun.SQL

```ts
import { SQL } from 'bun'
import PgBoss, { fromBunSql } from 'pg-boss'

const sql = new SQL(process.env.DATABASE_URL)

const boss = new PgBoss({ db: fromBunSql(sql) })

await boss.start()

await boss.createQueue('email')
await boss.send('email', { to: 'user@example.com' })
```

As with PGlite, you own the client. pg-boss doesn't call `end()` on it.

#### Enqueueing inside a transaction

The `db` option on `send()`, `insert()`, `complete()` and friends takes anything implementing
`executeSql` so that job writes can join a transaction you already own. On Drizzle over `bun-sql`, use
the [Drizzle adapter](api/adapters.md#drizzle) as with any other driver:

```ts
import { drizzle } from 'drizzle-orm/bun-sql'
import { sql } from 'drizzle-orm'
import { fromDrizzle } from 'pg-boss'

await db.transaction(async (tx) => {
  await tx.insert(orders).values({ item: 'widget', qty: 1 })

  await boss.send('order-processing', { item: 'widget' }, { db: fromDrizzle(tx, sql) })
})
```

Without Drizzle, wrap a `sql.begin()` transaction the same way `fromBunSql` wraps the client.

#### Driver differences

Three `Bun.SQL` behaviors differ from `pg` in ways pg-boss would otherwise trip over. You don't need
to do anything about them. The adapters handle array parameters and error codes. pg-boss's own SQL
handles parameter type inference. They're listed because the first explains the shape
of the queries you'll see in `pg_stat_statements`, and because the first two are upstream bugs that
a later Bun release may fix.

- **Array parameters.** Bun cannot encode a JS array as a PostgreSQL array parameter. It stringifies
  the array, which makes every `= ANY($n::uuid[])` fail with `malformed array literal`
  ([oven-sh/bun#18775](https://github.com/oven-sh/bun/issues/18775)). Both adapters expand an
  array-cast parameter into `ARRAY[$2,$3]` of scalar parameters. The bind count varies
  with the number of ids in a `complete()` or `cancel()` call.
- **Parameter type inference.** Because Bun infers a bind parameter's type from the cast in front of it,
  `$n::json` re-encodes an already-serialized payload
  ([oven-sh/bun#28819](https://github.com/oven-sh/bun/issues/28819)). To handle this behavior in the
  SQL instead of in an adapter, pg-boss routes those casts through `::text::json` for every driver.
- **Error codes.** Bun reports every server error as `ERR_POSTGRES_SERVER_ERROR` and puts the
  SQLSTATE in `errno`, where `pg` puts it in `code`. `fromBunSql` moves the SQLSTATE onto `code`,
  where pg-boss reads it to tell a lost fetch race from a real failure.

Transaction handling differs too, though the difference isn't visible from outside. pg-boss installs
its schema, migrates, and runs maintenance as `BEGIN; ... COMMIT;` scripts. Bun refuses such scripts
on a pooled connection (`Only use sql.begin, sql.reserved or max: 1`). `fromBunSql` reserves a connection
for the duration of each script.

#### LISTEN/NOTIFY

`useListenNotify` works on **Bun 1.4.0 and later**, which is where `sql.listen()` arrived
([oven-sh/bun#32089](https://github.com/oven-sh/bun/pull/32089)). Bun reconnects and re-subscribes on
its own, and reports each subscribe through the callback pg-boss uses to close the gap. The next
fetch then picks up the work behind any notification missed while the listener was down.

On an earlier Bun, the adapter exposes no listener at all. pg-boss emits a
`listen_notify_unavailable` warning and delivers by polling, which is the default and costs only
latency.

### Not supported: YugabyteDB

YugabyteDB is a PostgreSQL-compatible distributed database (it reports as PostgreSQL 15). A
`yugabytedb` profile exists, but releases are not tested against it. Upgrading an existing
deployment to a new pg-boss schema version does not work. The blocker is in YugabyteDB itself
([yugabyte-db#21833](https://github.com/yugabyte/yugabyte-db/issues/21833), still open). For a
distributed backend, use CockroachDB or Citus. If you run pg-boss on YugabyteDB, please report your
findings.

`backend: 'yugabytedb'` is deprecated and will be rejected in the next major. Setting it emits a Node
`DeprecationWarning` (code `PGBOSS_DEP_YUGABYTEDB`). Run with `--trace-deprecation` to find where it
is set.

**Until the next major, set `backend: 'yugabytedb'` to run on YugabyteDB.** It enables `noAdvisoryLocks`, `noTablePartitioning`,
`noIndexProgressView`, `noReindex` and `noMonitorVacuum`, and keeps the standard fetch mode. YugabyteDB does **not** need `noSkipLocked` or `noMultiMutationCte` (it has
neither CockroachDB's `SKIP LOCKED` issues nor the multi-mutation CTE restriction). The suite was
last run against a single-node YugabyteDB (`docker compose -f docker-compose.yugabyte.yaml up -d`,
`npm run test:yugabytedb:full`). Standard (non-partitioned) queueing worked: send / fetch / complete,
retries, job expiration, flows, and queue policies (`short` / `singleton` / `stately`).

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://localhost:5433/pgboss',
  backend: 'yugabytedb'
})
```

**Why `noTablePartitioning` is required.** pg-boss creates a per-queue partition with DDL (`CREATE
TABLE … PARTITION OF …`) inside the same transaction that inserts the queue row. Two YugabyteDB
behaviors make that transaction fail:

1. On a conflict, YugabyteDB can't transparently retry a multi-statement transaction sent over the
   *simple* query protocol. Because pg-boss wraps these operations in a `BEGIN; … ; COMMIT;` text
   block, the conflict surfaces as `current transaction is expired or aborted`.
2. Because DDL is **not rolled back transactionally**, the partition table survives the aborted
   transaction. A retry then fails with `relation "…" already exists`.

`noTablePartitioning` keeps all jobs in one table and skips the per-queue DDL, which avoids both
failures. The profile also enables `noAdvisoryLocks`, because advisory locks are a
[Tech Preview](https://github.com/yugabyte/yugabyte-db/issues/3642) on YugabyteDB.

**Not supported on YugabyteDB:** partitioned queues (`partition: true`), multi-master concurrent
startup, and schema migrations between pg-boss versions, which all involve DDL under contention. A
fresh install (`createSchema`) works, but upgrading an existing deployment does not. pg-boss
releases often include a schema migration.

Parameterizing the call doesn't fix the partitioned-queue case, because the problem goes beyond the
query protocol. `create_queue` was tested as a real client-side transaction and as a single
parameterized autocommit statement and still fails both ways. Once the partition DDL hits a
conflict, YugabyteDB reports `query layer retry isn't possible … some data was already
sent to the user` and aborts, because it can't transparently retry a transaction that performs DDL.
Avoiding the partition DDL (`noTablePartitioning`) is the only thing that works.

### Not supported: Aurora DSQL

Because Aurora DSQL has no `backend` profile, you can't currently configure pg-boss to run
against it. The notes below are for contributors evaluating a future profile.

[Amazon Aurora DSQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html)
is a serverless distributed SQL database with PostgreSQL compatibility. However, it uses
[optimistic concurrency control (OCC)](https://aws.amazon.com/blogs/database/concurrency-control-in-amazon-aurora-dsql/)
instead of traditional pessimistic locking, which changes how locking works.

**Feature support:**
- Table partitioning: ❌ [Not supported](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-migration-guide.html), since Aurora DSQL auto-manages distribution
- Foreign key constraints: ❌ Not supported
- Deferrable constraints: ❌ N/A (no FK constraints)
- Advisory locks: ❌ Not supported (OCC model)
- Covering indexes (INCLUDE): ✅ Supported
- Synchronous CREATE INDEX: ❌ Only [`CREATE INDEX ASYNC`](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html) supported

**Key concerns:**
1. **OCC vs pessimistic locking**: `SELECT FOR UPDATE` in Aurora DSQL doesn't lock rows. It flags
   them for conflict detection at commit time. `SKIP LOCKED` is not meaningful in this model.
2. **Async-only index creation**: pg-boss uses synchronous `CREATE INDEX` during schema migrations.
   Aurora DSQL only supports `CREATE INDEX ASYNC`, which may cause migration failures.
3. **Retry logic required**: OCC returns serialization errors on conflict instead of blocking.
   Applications must implement retry logic.

**A profile would need** the CockroachDB-style behavior: `noSkipLocked` (OCC doesn't support
`SKIP LOCKED` semantics), `noMultiMutationCte`, `noTablePartitioning`, `noDeferrableConstraints`, and
`noAdvisoryLocks`. Compatibility is **uncertain** regardless, because of async-only index
creation and OCC behavior. If you experiment with Aurora DSQL, please report your findings.

### Not supported: Spanner

Because Spanner has no `backend` profile, you can't currently configure pg-boss for it. Google Cloud
Spanner provides PostgreSQL wire compatibility through
[PGAdapter](https://cloud.google.com/spanner/docs/pgadapter). A profile would likely need
`noSkipLocked`, `noMultiMutationCte`, `noTablePartitioning`, `noDeferrableConstraints`, and
`noAdvisoryLocks` like CockroachDB, but Spanner's more limited PostgreSQL support may cause other
incompatibilities. If you experiment with Spanner, please report your findings.

## Scaling beyond a single table

For high-throughput workloads (thousands of jobs per second), `noSkipLocked` alone may not be
enough. At scale, contention on the job table becomes a bottleneck regardless of the fetch
strategy.

### Application-level sharding

A more scalable approach is to shard work at the application level using `singletonKey`:

```typescript
// Each worker claims a partition (e.g., via consistent hashing or assignment)
const workerId = process.env.WORKER_ID // 0, 1, 2, ...
const totalWorkers = parseInt(process.env.TOTAL_WORKERS)

// Send jobs with partition assignment
await boss.send('my-queue', jobData, {
  singletonKey: `partition-${jobId % totalWorkers}`
})

// Each worker only processes its partition
await boss.work('my-queue', {
  singletonKey: `partition-${workerId}`
}, handler)
```

### Hash-based distribution

For CockroachDB specifically, consider [hash-sharded indexes](https://www.cockroachlabs.com/docs/stable/hash-sharded-indexes)
to distribute write load across ranges. Hash-sharded indexes help avoid hotspots when inserting time-ordered jobs.

### Alternative systems

**Use pg-boss** (database-backed queue) when:
- Throughput is under ~10,000 jobs/second (PostgreSQL handles this comfortably)
- Processing time >> fetch time (typical for background jobs)
- Transactional consistency with your data is required
- You want to minimize infrastructure complexity

**Consider dedicated message queues** (Kafka, Redis Streams) when:
- Sustained throughput exceeds ~50,000 jobs/second
- Job processing times are sub-millisecond
- Fire-and-forget semantics are acceptable

**Throughput reference points:**
- PostgreSQL job queues: 7-30k jobs/sec ([benchmarks](https://gist.github.com/chanks/7585810), [Tembo MQ](https://legacy.tembo.io/blog/mq-stack-benchmarking/))
- Kafka: 1-2M messages/sec ([LinkedIn](https://engineering.linkedin.com/kafka/benchmarking-apache-kafka-2-million-writes-second-three-cheap-machines), [Honeycomb](https://developer.confluent.io/learn-more/podcasts/handling-2-million-apache-kafka-messages-per-second-at-honeycomb/))
- Redis Streams: 1-7M messages/sec ([benchmarks](https://goatreview.com/building-a-high-performance-message-queue-with-redis-streams/))

## Known limitations and race conditions

The limitations below apply when pg-boss runs with `noSkipLocked` (the atomic-UPDATE fetch path).

### Serialization errors (CockroachDB)

CockroachDB uses SERIALIZABLE isolation by default. Under high contention, transactions may fail with
serialization errors (`40001`) and need to retry. `fetch()` rejects with that error. No job is lost,
because a worker emits the error as an `error` event and fetches again on its next poll.

### Empty results under contention

With `noSkipLocked`, when multiple workers fetch concurrently:

1. All workers' CTEs may select the same candidate jobs (no row locking)
2. All workers attempt the `UPDATE`
3. One succeeds, the others fail the `state < 'active'` recheck
4. Failed workers receive empty results

These empty results are the documented trade-off. For job queues where processing time >> fetch
time, the trade-off is acceptable because workers poll again.

### Compatibility notes

- Priorities, groups, singletons and retries work on every backend. The features that don't work
  everywhere are listed above, such as partitioned queues on CockroachDB and YugabyteDB. CockroachDB
  also has no LISTEN/NOTIFY and no heartbeat on a transactional worker.
- The atomic-`UPDATE` fetch (`noSkipLocked`) has no benefit on stock PostgreSQL. Under contention,
  workers receive empty results instead of skipping to unlocked rows. pg-boss therefore enables the
  atomic fetch only for the backends that need it, which never includes `backend: 'postgres'`.
