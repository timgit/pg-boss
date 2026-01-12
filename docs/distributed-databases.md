# Distributed Database Support

pg-boss includes a `distributedDatabaseMode` option for use with PostgreSQL-compatible distributed SQL databases like YugabyteDB and Citus.

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

```typescript
import PgBoss from 'pg-boss'

const boss = new PgBoss({
  connectionString: 'postgresql://localhost:5433/pgboss', // YugabyteDB
  distributedDatabaseMode: true
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

## Recommendations

- **CockroachDB**: Use `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes`
- **YugabyteDB**: Use `noAdvisoryLocks` (unless preview feature enabled). Standard fetch mode works well.
- **Citus**: Use `distributedDatabaseMode` if job table is distributed; standard mode if using reference tables
- **Aurora DSQL**: Use `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks`. Compatibility uncertain due to OCC and async-only indexes.
- **PostgreSQL**: Use standard mode (no special options needed)

## Transaction Isolation

For optimal correctness in distributed mode, SERIALIZABLE isolation ensures exactly-once job processing. This is the recommended isolation level for distributed work queues.

With standard PostgreSQL or YugabyteDB's default READ COMMITTED isolation level, the `state < 'active'` check in the UPDATE prevents duplicate claims.

## Database Compatibility

pg-boss uses PostgreSQL's declarative table partitioning (`PARTITION BY LIST`) for queue management. This requires full PostgreSQL syntax compatibility:

| Database | Status | Required Options |
|----------|--------|------------------|
| PostgreSQL | Tested | None |
| CockroachDB | Tested | `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes` |
| YugabyteDB | Untested (likely compatible) | `noAdvisoryLocks` (unless preview feature enabled) |
| Citus | Untested (likely compatible) | `distributedDatabaseMode` if job table is distributed across shards |
| Aurora DSQL | Untested (uncertain) | Likely `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` (see notes) |
| Spanner | Untested (uncertain) | Likely `distributedDatabaseMode` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes` |

### Tested: PostgreSQL

PostgreSQL is the primary supported database with full feature support.

### Tested: CockroachDB

CockroachDB requires several compatibility options:

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

### Untested: YugabyteDB (likely compatible)

YugabyteDB is a PostgreSQL-compatible distributed database with [native job queue support](https://docs.yugabyte.com/stable/develop/data-modeling/common-patterns/jobqueue/). YugabyteDB [recommends](https://www.yugabyte.com/blog/distributed-fifo-job-queue/) using `SELECT FOR UPDATE SKIP LOCKED` for job queues, and has optimizations for single-row transactions that make this pattern efficient.

**Feature support:**
- Table partitioning: ✅ Fully supported
- Deferrable constraints: ✅ Supported for foreign keys
- Covering indexes (INCLUDE): ✅ Fully supported
- Advisory locks: ⚠️ [Tech Preview](https://github.com/yugabyte/yugabyte-db/issues/3642) - requires enabling GFlags

**Recommendation:** Use `noAdvisoryLocks: true` unless you have enabled the advisory locks preview feature (requires setting `ysql_yb_enable_advisory_locks=true`). Standard fetch mode works well - YugabyteDB does not have the `SKIP LOCKED` issues that CockroachDB has.

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://localhost:5433/pgboss',
  noAdvisoryLocks: true  // Required unless preview feature enabled
})
```

If you use pg-boss with YugabyteDB, please report your findings.

### Untested: Citus (likely compatible)

Citus is a distributed PostgreSQL extension that shards tables across multiple nodes. However, `SELECT FOR UPDATE` [only works for single-shard queries](https://docs.citusdata.com/en/stable/develop/reference_workarounds.html) in Citus - cross-shard locking is not supported.

**Recommendation:**
- If the pg-boss job table is a **reference table** (replicated to all nodes): Standard mode works fine.
- If the pg-boss job table is **distributed across shards**: `distributedDatabaseMode: true` is required since `SELECT FOR UPDATE SKIP LOCKED` will error on cross-shard queries.

If you use pg-boss with Citus, please report your findings.

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
