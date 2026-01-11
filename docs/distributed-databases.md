# Distributed Database Support

pg-boss includes a `distributedDatabaseMode` option for use with distributed SQL databases like CockroachDB, YugabyteDB, and TiDB.

## Background

By default, pg-boss uses `SELECT FOR UPDATE SKIP LOCKED` for job fetching. This approach works well with PostgreSQL but has known issues with distributed databases:

### CockroachDB Issues with SKIP LOCKED

1. **Performance degradation under concurrency**: In tests with 500 workers, mean latency for `SELECT FOR UPDATE SKIP LOCKED` reached 311ms - far higher than expected. ([cockroachdb/cockroach#97135](https://github.com/cockroachdb/cockroach/issues/97135))

2. **Unexpected row skipping**: `SELECT FOR UPDATE SKIP LOCKED` can sometimes skip unlocked rows unexpectedly, causing workers to miss available work items. ([cockroachdb/cockroach#121917](https://github.com/cockroachdb/cockroach/issues/121917))

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
- Uses `FROM next` JOIN instead of `WHERE id IN (subquery)` for better performance in CockroachDB
- Additional `state < 'active'` check in the UPDATE to prevent duplicate claims under concurrent execution

This pattern is recommended by CockroachDB engineers for distributed work queues. See [Andrew Werner's article on distributed work queues](https://dev.to/ajwerner/quick-and-easy-exactly-once-distributed-work-queues-using-serializable-transactions-jdp) for more details.

## Usage

```typescript
import PgBoss from 'pg-boss'

const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
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

- **Always enable `distributedDatabaseMode` when using CockroachDB** - The standard `SKIP LOCKED` approach has documented issues.

## Transaction Isolation

For optimal correctness in distributed mode, CockroachDB defaults to SERIALIZABLE isolation which ensures exactly-once job processing. This is the recommended isolation level for distributed work queues.

If using distributed mode with standard PostgreSQL, the default READ COMMITTED isolation level is sufficient since the `state < 'active'` check in the UPDATE prevents duplicate claims.

## Other Distributed Databases

While the documented issues are specific to CockroachDB, `distributedDatabaseMode` may also benefit other distributed SQL databases that have suboptimal performance or correctness issues with `SELECT FOR UPDATE SKIP LOCKED`:

- **YugabyteDB** - PostgreSQL-compatible distributed database with [native job queue support](https://docs.yugabyte.com/stable/develop/data-modeling/common-patterns/jobqueue/). Supports `SKIP LOCKED` but may benefit from distributed mode under high contention.
- **TiDB** - MySQL-compatible distributed database. `SKIP LOCKED` support is [not yet implemented](https://github.com/pingcap/tidb/issues/18207). Distributed mode is necessary until support is added.
- **Citus** - Distributed PostgreSQL extension. May benefit under high worker concurrency across shards.
- **Spanner (with PGAdapter)** - Google Cloud Spanner with PostgreSQL interface.

When using any distributed database, we recommend testing with `distributedDatabaseMode` enabled to compare performance and correctness under your specific workload.

## Scaling Beyond Distributed Mode

For very high-throughput workloads (thousands of jobs per second), `distributedDatabaseMode` alone may not be sufficient. At scale, contention on the job table becomes a bottleneck regardless of the fetch strategy.

### Partitioning by Worker

A more scalable approach is to partition work at the application level:

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
