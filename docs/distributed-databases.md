# Distributed Database Support

pg-boss includes a `distributedDatabaseMode` option for use with PostgreSQL-compatible distributed SQL databases like YugabyteDB and Citus.

## Backend profiles

The `backend` option selects the database pg-boss is running against. It is a general mechanism —
not specific to distributed databases — that expands to the right combination of compatibility flags
so you don't have to wire them up by hand:

```typescript
import PgBoss from 'pg-boss'

// Equivalent to setting distributedDatabaseMode + all four no* flags manually:
const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  backend: 'cockroachdb'
})
```

Each backend has a *kind* — `standard` (stock PostgreSQL), `distributed` (clustered
Postgres-compatible engines), or `embedded` (in-process PostgreSQL). The flags follow from the kind:

| `backend` | Kind | Expands to |
|-----------|------|------------|
| `postgres` *(default)* | standard | *(no flags)* |
| `cockroachdb` | distributed | `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes` |
| `yugabytedb` | distributed | `noAdvisoryLocks` + `noTablePartitioning` |
| `citus` | distributed | *(no flags — coordinator-local tables behave like plain PostgreSQL)* |
| `pglite` | embedded | *(no flags — full PostgreSQL; see [PGlite](pglite.md))* |

Note that `pglite` is **not** a distributed backend — it is embedded single-connection PostgreSQL
and is documented on its own [PGlite](pglite.md) page. It appears here only because it shares the
same `backend` selection mechanism.

Any individual flag you set explicitly always **overrides** the profile, so you can start from a
profile and fine-tune. Databases without a profile yet (Aurora DSQL, Spanner) are configured by
setting the individual flags directly — see the [compatibility table](#database-compatibility).

## Background

By default, pg-boss uses `SELECT FOR UPDATE SKIP LOCKED` for job fetching. This approach works well with PostgreSQL but may have issues in distributed databases:

### Known Issues with SKIP LOCKED in Distributed Databases

1. **Performance degradation under concurrency**: In distributed database tests with 500 workers, mean latency for `SELECT FOR UPDATE SKIP LOCKED` can reach 311ms or higher. ([example from CockroachDB](https://github.com/cockroachdb/cockroach/issues/97135))

2. **Unexpected row skipping**: `SELECT FOR UPDATE SKIP LOCKED` can sometimes skip unlocked rows unexpectedly, causing workers to miss available work items. ([example](https://github.com/cockroachdb/cockroach/issues/121917))

## The Solution: Atomic UPDATE Pattern

When `distributedDatabaseMode` is enabled, pg-boss uses an atomic `UPDATE...RETURNING` pattern with a JOIN instead of `FOR UPDATE SKIP LOCKED`:

```sql
WITH next AS (
  SELECT id FROM jobs
  WHERE name = $name
    AND state < 'active'
    AND start_after < now()
  ORDER BY priority DESC, created_on, id
  LIMIT $batchSize
)
UPDATE jobs j SET
  state = 'active',
  started_on = now(),
  retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
FROM next
WHERE j.id = next.id
  AND j.state < 'active'  -- Additional check for concurrent safety
RETURNING j.*
```

Key differences from standard mode:
- No `FOR UPDATE SKIP LOCKED` clause in the CTE
- Uses `FROM next` JOIN instead of `WHERE id IN (subquery)` for better performance in distributed databases
- Additional `state < 'active'` check in the UPDATE to prevent duplicate claims under concurrent execution

This pattern is recommended for distributed work queues. See [Andrew Werner's article on distributed work queues](https://dev.to/ajwerner/quick-and-easy-exactly-once-distributed-work-queues-using-serializable-transactions-jdp) for more details.

## Usage

The simplest way to enable distributed mode is via a [backend profile](#backend-profiles). To opt in
directly on a database without a profile, set `distributedDatabaseMode` (and any other required
flags) yourself:

```typescript
import PgBoss from 'pg-boss'

const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  backend: 'cockroachdb' // or set distributedDatabaseMode + flags manually
})

await boss.start()
```

## Trade-offs

### Standard Mode (PostgreSQL)
- Uses `SELECT FOR UPDATE SKIP LOCKED`
- Multiple workers can efficiently fetch different jobs simultaneously
- Locked rows are skipped immediately
- Best for single-node PostgreSQL

### Distributed Database Mode
- Uses atomic `UPDATE...RETURNING`
- Under high contention, some workers may receive empty results
- No row-level locking contention
- Only for distributed databases where `SKIP LOCKED` has performance or correctness issues
- Trade-off of empty results is acceptable when processing time >> fetch time (typical for job queues)

> **Note:** distributed mode only replaces `SKIP LOCKED` in the *fetch* path. Other operations
> (e.g. unblocking flow dependents) still use `SELECT ... FOR UPDATE` without `SKIP LOCKED`, which
> distributed engines like CockroachDB support fine — it is specifically `SKIP LOCKED` that is
> avoided, not all row locking.

## Recommendations

- **CockroachDB**: `backend: 'cockroachdb'` (= `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes`)
- **YugabyteDB**: `backend: 'yugabytedb'` (= `noAdvisoryLocks` + `noTablePartitioning`, standard fetch mode). Partially compatible — non-partitioned queueing works (incl. queue policies); partitioned queues, multi-master startup, and live migrations hit a YugabyteDB transaction/DDL limitation ([#21833](https://github.com/yugabyte/yugabyte-db/issues/21833)). See below.
- **Citus**: `backend: 'citus'` (standard mode, no flags — the full suite passes against a single-node coordinator). Only use `distributedDatabaseMode` if you explicitly shard the job table with `create_distributed_table()`.
- **Aurora DSQL**: currently **not supported**. pg-boss provisions its schema with synchronous `CREATE INDEX`, which Aurora DSQL does not offer (indexes are created asynchronously), so migrations cannot complete. The flag combination would be `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks`, but this is untested and blocked on the indexing limitation.
- **PostgreSQL**: Use standard mode (no special options needed)

## Transaction Isolation

For optimal correctness in distributed mode, SERIALIZABLE isolation ensures exactly-once job processing. This is the recommended isolation level for distributed work queues.

With standard PostgreSQL or YugabyteDB's default READ COMMITTED isolation level, the `state < 'active'` check in the UPDATE prevents duplicate claims.

## Database Compatibility

pg-boss uses PostgreSQL's declarative table partitioning (`PARTITION BY LIST`) for queue management. This requires full PostgreSQL syntax compatibility:

| Database | Status | `backend` profile | Expands to / required options |
|----------|--------|-------------------|-------------------------------|
| PostgreSQL | Tested | `postgres` | None |
| CockroachDB | Tested | `cockroachdb` | `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes` |
| YugabyteDB | Partially compatible (tested) | `yugabytedb` | `noAdvisoryLocks` + `noTablePartitioning` + standard fetch; partitioned queues / multi-master / live migrations fail ([#21833](https://github.com/yugabyte/yugabyte-db/issues/21833)) |
| Citus | Compatible (tested, full suite) | `citus` | Standard mode, no flags (coordinator-local tables); `distributedDatabaseMode` only if you shard the job table |
| Aurora DSQL | Untested (uncertain) | *(none — set flags)* | Likely `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` (see notes) |
| Spanner | Untested (uncertain) | *(none — set flags)* | Likely `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes` |

### Tested: PostgreSQL

PostgreSQL is the primary supported database with full feature support.

### Tested: CockroachDB

CockroachDB requires several compatibility options. Use the `cockroachdb` profile:

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  backend: 'cockroachdb'
})
```

…which is exactly equivalent to setting each flag by hand:

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  distributedDatabaseMode: true,     // Use atomic UPDATE instead of SKIP LOCKED
  noTablePartitioning: true,         // Disable PostgreSQL-style partitioning
  noDeferrableConstraints: true,     // Disable DEFERRABLE foreign key constraints
  noAdvisoryLocks: true,             // Disable pg_advisory_xact_lock
  noCoveringIndexes: true            // Disable INCLUDE clause in indexes
})
```

**Limitations when using `noTablePartitioning`:**
- Queue-level partitioning (`partition: true` on createQueue) is not supported
- All jobs stored in a single table instead of per-queue partitions

CockroachDB uses a [different partitioning model](https://www.cockroachlabs.com/docs/stable/partitioning) that requires partition columns in the PRIMARY KEY and partitions defined inline at table creation.

#### Testing distributed mode

`distributedDatabaseMode` is a pure runtime fetch-strategy toggle (no schema impact) that works on
plain PostgreSQL, so the project exercises it two ways:

- **`npm run test:distributed`** — runs the **entire** test suite on Postgres with
  `DISTRIBUTED=true`, which makes `test/testHelper.ts`'s `getConfig()` enable
  `distributedDatabaseMode` for every test. This is the primary distributed-mode safety net: any new
  test added to the suite is automatically exercised against the distributed code paths, fast and
  reliably, without paying CockroachDB's slow per-test DDL. It runs as its own CI job.
- **`npm run test:cockroachdb`** — runs `test/distributedDatabaseTest.ts` against a real CockroachDB
  cluster (`DB_TYPE=cockroachdb`, which also enables the compatibility flags above). This is a
  focused smoke test confirming actual CockroachDB compatibility, and runs on every push/PR.
- **`npm run test:cockroachdb:full`** — runs the **entire** suite against a real CockroachDB cluster
  (`--no-file-parallelism`, so the slow per-test DDL doesn't overwhelm the cluster). This is the
  compatibility matrix / regression signal. It's slow — CockroachDB rebuilds the schema per test and
  pays ~8-19s of online schema changes each, so the suite takes the better part of an hour — and
  therefore runs **nightly and on demand** (`workflow_dispatch`) rather than gating PRs. When running
  against CockroachDB the per-test timeout is raised automatically (see `vitest.config.ts`) so slow
  DDL reports as a real result rather than a spurious timeout.

For tests that depend on PostgreSQL-only features (table partitioning, covering indexes, or an exact
PostgreSQL schema/migration shape), `test/testHelper.ts` exports `itPostgresOnly` /
`describePostgresOnly`, which skip under CockroachDB. For data-driven tests that loop over
`partition: true`/`false`, narrow the cases with `helper.isCockroachDb`.

`test/distributedDatabaseTest.ts` holds the distributed-mode-specific invariants the general suite
cannot express (concurrent-fetch deduplication, `failDistributed`/`completeDistributed` composition
inside a caller transaction, and the compatibility-flag construction paths). Those cases opt into
`distributedDatabaseMode` explicitly, so they run in every mode.

**Verified on CockroachDB** (full-suite run, PostgreSQL-only tests skipped): job send/fetch,
complete, fail (by id), retry of an explicitly failed job (including exponential backoff and
`retryDelayMax`), **maintenance expiration of timed-out jobs** (`expireInSeconds`), **heartbeat
config + heartbeat-timeout** (`heartbeatSeconds`), queue policies (`short`/`singleton`/`stately`
with `partition: false`), throttle/debounce, deferral, cancellation, and flow dependency
blocking/unblocking — including a blocking parent that fails and retries.

In `distributedDatabaseMode` the supervisor's expiry (`failJobsByTimeout` / `failJobsByHeartbeat`)
uses CockroachDB-safe split statements instead of the multi-mutation `failJobs()` CTE (which
CockroachDB rejects with `multiple mutations of the same table "job" are not supported`), so
timed-out and heartbeat-timed-out jobs are correctly moved to `retry`/`failed` rather than stranded
in `active`. CockroachDB returns integer columns as text, so numeric job and queue fields (including
`heartbeatSeconds`) are coerced back to numbers on read in distributed mode.

### Partially compatible: YugabyteDB

YugabyteDB is a PostgreSQL-compatible distributed database (reports as PostgreSQL 15). pg-boss has
been tested against a single-node YugabyteDB (`docker compose --profile yugabyte up -d`,
`npm run test:yugabytedb:full`). Basic queueing works, but there is a significant caveat.

**Use `noAdvisoryLocks: true` + `noTablePartitioning: true`, standard fetch mode** (not
`distributedDatabaseMode` — YugabyteDB does not have the `SKIP LOCKED` issues CockroachDB has). With
those flags, standard (non-partitioned) queueing works: send / fetch / complete, retries, job
expiration, flows, and queue policies (`short` / `singleton` / `stately`).

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://localhost:5433/pgboss',
  backend: 'yugabytedb' // = noAdvisoryLocks + noTablePartitioning
})
```

**Why `noTablePartitioning` is required.** pg-boss creates a per-queue partition with DDL (`CREATE
TABLE … PARTITION OF …`) inside the same transaction that inserts the queue row. Two YugabyteDB
behaviors make this fail:

1. It cannot transparently retry a multi-statement transaction sent over the *simple* query
   protocol on a conflict ([yugabyte-db#21833](https://github.com/yugabyte/yugabyte-db/issues/21833))
   — and pg-boss wraps these operations in a `BEGIN; … ; COMMIT;` text block, so the conflict surfaces
   as `current transaction is expired or aborted`.
2. DDL is **not rolled back transactionally**, so the partition table survives the aborted
   transaction — a retry then fails with `relation "…" already exists`.

`noTablePartitioning` keeps all jobs in one table and skips the per-queue DDL, sidestepping both.
Advisory locks are a [Tech Preview](https://github.com/yugabyte/yugabyte-db/issues/3642) on
YugabyteDB, hence `noAdvisoryLocks`.

**Still not reliable on YugabyteDB:** partitioned queues (`partition: true`), multi-master
concurrent startup, and live schema migrations between pg-boss versions — all involve DDL under
contention. A fresh install (`createSchema`) is fine; upgrading an existing deployment is not.

For the partitioned-queue case specifically, this is **not** just a query-protocol problem and
cannot be fixed by parameterizing the call. Running `create_queue` as a real client-side transaction,
or as a single parameterized autocommit statement, was tested and still fails: once the partition
DDL hits a conflict YugabyteDB reports `query layer retry isn't possible … some data was already
sent to the user` and aborts, because it cannot transparently retry a transaction that performs DDL.
Avoiding the partition DDL (`noTablePartitioning`) is the only thing that works.

### Tested: Citus (compatible in standard mode)

Citus is a PostgreSQL extension that can shard tables across nodes. pg-boss never calls
`create_distributed_table()`, so its tables stay **local to the coordinator** and behave like plain
PostgreSQL. The **full pg-boss test suite passes** against a single-node Citus coordinator
(`citusdata/citus`, PostgreSQL 18 + Citus 14) with the `citus` extension loaded and **no special
flags** — partitioning, queue policies, flows, heartbeat, multi-master, and migrations all work.

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://localhost:5434/pgboss',
  backend: 'citus' // standard mode, no flags
})
```

Run it yourself: `docker compose --profile citus up -d` then `npm run test:citus:full`.

**The one caveat is opt-in.** If you deliberately shard the pg-boss job table with
`create_distributed_table()`, `SELECT FOR UPDATE SKIP LOCKED`
[only works for single-shard queries](https://docs.citusdata.com/en/stable/develop/reference_workarounds.html)
— so a *distributed* job table would need `distributedDatabaseMode: true`. A **reference table**
(replicated to all nodes) or the default coordinator-local table both work in standard mode.

### Untested: Aurora DSQL (uncertain)

[Amazon Aurora DSQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html) is a serverless distributed SQL database with PostgreSQL compatibility. However, it uses [optimistic concurrency control (OCC)](https://aws.amazon.com/blogs/database/concurrency-control-in-amazon-aurora-dsql/) instead of traditional pessimistic locking, which fundamentally changes how locking works.

**Feature support:**
- Table partitioning: ❌ [Not supported](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-migration-guide.html) - Aurora DSQL auto-manages distribution
- Foreign key constraints: ❌ Not supported
- Deferrable constraints: ❌ N/A (no FK constraints)
- Advisory locks: ❌ Not supported (OCC model)
- Covering indexes (INCLUDE): ✅ Supported
- Synchronous CREATE INDEX: ❌ Only [`CREATE INDEX ASYNC`](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html) supported

**Key concerns:**
1. **OCC vs pessimistic locking**: `SELECT FOR UPDATE` in Aurora DSQL doesn't lock rows - it flags them for conflict detection at commit time. `SKIP LOCKED` is not meaningful in this model.
2. **Async-only index creation**: pg-boss uses synchronous `CREATE INDEX` during schema migrations. Aurora DSQL only supports `CREATE INDEX ASYNC`, which may cause migration failures.
3. **Retry logic required**: OCC returns serialization errors on conflict instead of blocking. Applications must implement retry logic.

**Recommendation:** If attempting to use Aurora DSQL, you would need:
```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://...',
  distributedDatabaseMode: true,   // OCC doesn't support SKIP LOCKED semantics
  noTablePartitioning: true,       // Not supported
  noDeferrableConstraints: true,   // No FK constraints
  noAdvisoryLocks: true            // Not supported with OCC
})
```

⚠️ **Compatibility is uncertain** due to async-only index creation and OCC behavior. If you test pg-boss with Aurora DSQL, please report your findings.

### Untested: Spanner (uncertain)

- **Spanner (with PGAdapter)** - Google Cloud Spanner provides PostgreSQL wire compatibility via [PGAdapter](https://cloud.google.com/spanner/docs/pgadapter). Compatibility is uncertain due to Spanner's more limited PostgreSQL support. It likely requires `distributedDatabaseMode`, `noTablePartitioning`, `noDeferrableConstraints`, and `noAdvisoryLocks` like CockroachDB, but may have other incompatibilities. If you test pg-boss with Spanner, please report your findings.

## Scaling Beyond Distributed Mode

For very high-throughput workloads (thousands of jobs per second), `distributedDatabaseMode` alone may not be sufficient. At scale, contention on the job table becomes a bottleneck regardless of the fetch strategy.

### Application-Level Sharding

A more scalable approach is to shard work at the application level using singletonKey:

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

### Hash-Based Distribution

For CockroachDB specifically, consider [hash-sharded indexes](https://www.cockroachlabs.com/docs/stable/hash-sharded-indexes) to distribute write load across ranges. This helps avoid hotspots when inserting time-ordered jobs.

### When to Use Alternative Systems

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

## Known Limitations and Race Conditions

### Cache Staleness

pg-boss caches queue metadata (including active singleton keys) with a configurable refresh interval (`queueCacheIntervalSeconds`, default 60s). In distributed mode under high concurrency:

- Two workers may both see stale cache showing no active singletons
- Both attempt to claim jobs with the same singleton key
- The `state < 'active'` check prevents duplicate claims, but one worker receives empty results

This is a performance issue, not a correctness issue - no job is processed twice.

### Serialization Errors (CockroachDB)

CockroachDB uses SERIALIZABLE isolation by default. Under high contention, transactions may fail with serialization errors and need to retry. pg-boss's fetch operation treats all errors as "no jobs available" and returns empty results. The worker will retry on the next poll cycle.

### Empty Results Under Contention

In distributed mode, when multiple workers fetch concurrently:

1. All workers' CTEs may select the same candidate jobs (no row locking)
2. All workers attempt the UPDATE
3. One succeeds, others fail the `state < 'active'` check
4. Failed workers receive empty results

This is the documented trade-off. For job queues where processing time >> fetch time, this is acceptable. Workers simply poll again.

## Compatibility Notes

- All pg-boss features (priorities, groups, singletons, retries, etc.) work in distributed mode
- You can enable `distributedDatabaseMode` on standard PostgreSQL for testing, but it offers no benefit - under contention, workers will receive empty results instead of efficiently skipping to unlocked rows

## Compatibility Options Reference

pg-boss provides several options to work with databases that don't support all PostgreSQL features:

### `backend`

**Default:** `'postgres'`

A named database backend (`'postgres'`, `'cockroachdb'`, `'yugabytedb'`, `'citus'`, `'pglite'`) that
expands to the right preset of the flags below. See [Backend profiles](#backend-profiles). Any flag
set explicitly takes precedence over the profile.

### `distributedDatabaseMode`

**Default:** `false`

Enables an alternative job fetching pattern optimized for distributed databases.

- **Standard mode:** Uses `SELECT FOR UPDATE SKIP LOCKED` for efficient concurrent job fetching
- **Distributed mode:** Uses atomic `UPDATE...RETURNING` with a JOIN, adding an extra `state < 'active'` check

**When to use:**
- CockroachDB: Required (SKIP LOCKED has performance/correctness issues)
- YugabyteDB: Not recommended (supports SKIP LOCKED well)
- Citus: Required if job table is distributed across shards (SKIP LOCKED only works for single-shard queries)
- Aurora DSQL: Required (uses OCC, SKIP LOCKED semantics don't apply)
- PostgreSQL: Not recommended (standard mode is more efficient)

**Trade-off:** Under high contention, some workers may receive empty results instead of efficiently claiming different jobs.

### `noTablePartitioning`

**Default:** `false`

Disables PostgreSQL-style declarative table partitioning (`PARTITION BY LIST`).

**When to use:**
- CockroachDB: Required (uses a different partitioning model)
- Aurora DSQL: Required (auto-manages distribution)
- Spanner: Likely required

**Trade-off:** Queue-level partitioning (`partition: true` on `createQueue`) is not available. All jobs are stored in a single table.

### `noDeferrableConstraints`

**Default:** `false`

Disables `DEFERRABLE INITIALLY DEFERRED` on foreign key constraints.

PostgreSQL's deferrable constraints allow constraint checks to be postponed until transaction commit, which is useful for certain operations. Some distributed databases don't support this syntax.

**When to use:**
- CockroachDB: Required (syntax not supported)
- Aurora DSQL: Required (FK constraints not supported)
- Spanner: Likely required

**Trade-off:** Foreign key constraints are checked immediately rather than at transaction commit. This shouldn't affect normal pg-boss operations.

### `noAdvisoryLocks`

**Default:** `false`

Disables PostgreSQL advisory locks (`pg_advisory_xact_lock`).

pg-boss uses advisory locks for leader election and coordination in maintenance operations. Some distributed databases don't support advisory locks.

**When to use:**
- CockroachDB: Required (`pg_advisory_xact_lock` not available)
- YugabyteDB: Required unless advisory locks preview feature is enabled (requires GFlags)
- Aurora DSQL: Required (not supported with OCC model)
- Spanner: Likely required

**Trade-off:** Multiple pg-boss instances may occasionally perform redundant maintenance operations. This is a performance consideration, not a correctness issue.

### `noCoveringIndexes`

**Default:** `false`

Disables the `INCLUDE` clause in covering indexes.

PostgreSQL 11+ supports covering indexes that include additional columns for index-only scans. CockroachDB supports `INCLUDE` but automatically includes primary key columns, causing errors when those columns are explicitly specified.

**When to use:**
- CockroachDB: Required (implicitly includes PK columns, causing "already contains column" errors)
- Spanner: Likely required

**Trade-off:** Slightly less efficient index-only scans for job fetching. The performance impact is minimal for most workloads.
