# Database Backends

pg-boss runs on stock single-node PostgreSQL by default, but it also supports several
PostgreSQL-compatible backends — distributed SQL engines like CockroachDB, YugabyteDB, and Citus,
and the embedded WASM build [PGlite](https://pglite.dev). You select one with the `backend` option,
which applies all the compatibility behavior that backend needs.

## Backend profiles

`backend` is the **only** option you set — it selects the database pg-boss is running against and
turns on the right combination of internal compatibility behavior for it:

```typescript
import PgBoss from 'pg-boss'

const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  backend: 'cockroachdb'
})
```

Each backend has a *kind* — `standard` (stock PostgreSQL), `distributed` (clustered
Postgres-compatible engines), or `embedded` (in-process PostgreSQL):

| `backend` | Kind | Compatibility behavior it enables |
|-----------|------|-----------------------------------|
| `postgres` *(default)* | standard | *(none — full PostgreSQL)* |
| `cockroachdb` | distributed | `noSkipLocked` + `noMultiMutationCte` + `noTablePartitioning` + `noDeferrableConstraints` + `noAdvisoryLocks` + `noCoveringIndexes` (+ numeric coercion) |
| `yugabytedb` | distributed | `noAdvisoryLocks` + `noTablePartitioning` |
| `citus` | distributed | *(none — coordinator-local tables behave like plain PostgreSQL)* |
| `pglite` | embedded | *(none — full PostgreSQL; see [PGlite](#pglite-embedded))* |

The individual flags named in that table are **internal** — they are derived from `backend` and
are not separately configurable, so a deployment can't end up with an inconsistent combination.
The rest of this page explains what each one does. Databases without a profile (Aurora DSQL,
Spanner) are **not yet supported**.

## What each backend changes internally

The named compatibility flags below are set for you by `backend`; you never set them directly. They
are documented here so you understand what a given backend does differently from stock PostgreSQL.

| Internal flag | Effect | Trade-off |
|---------------|--------|-----------|
| `noSkipLocked` | Fetch jobs with an atomic `UPDATE ... RETURNING` (plus a `state < 'active'` recheck) instead of `SELECT FOR UPDATE SKIP LOCKED`. | Under high contention some workers get empty results instead of skipping to unlocked rows. |
| `noMultiMutationCte` | Run `complete`, `fail`, and supervisor expiry as split statements inside a transaction rather than a single multi-mutation CTE. | A few extra round-trips per command; negligible for normal workloads. |
| `noTablePartitioning` | Create the job table without `PARTITION BY LIST`. | Per-queue partitioning (`partition: true`) is unavailable; all jobs share one table. |
| `noDeferrableConstraints` | Omit `DEFERRABLE INITIALLY DEFERRED` on foreign keys. | Constraints check immediately rather than at commit (no effect on normal operation). |
| `noAdvisoryLocks` | Disable `pg_advisory_xact_lock` (used to coordinate schema creation/migration). | Concurrent instances may occasionally do redundant maintenance — a performance, not correctness, concern. |
| `noCoveringIndexes` | Omit the `INCLUDE` clause on covering indexes. | Slightly less efficient index-only scans during fetch; minimal for most workloads. |

`noSkipLocked` and `noMultiMutationCte` are **runtime** behaviors; the four `no*` gates are **schema**
choices applied at install/migration time. CockroachDB needs all six; other distributed engines need
only a subset (see below). One further CockroachDB adjustment — coercing text-encoded integers back
to numbers — is keyed on `backend === 'cockroachdb'` directly (see below).

### Why fetch and mutation strategy are tracked separately

`noSkipLocked` and `noMultiMutationCte` address two unrelated limitations that happen to coincide on
CockroachDB but are independent in principle:

- **`noSkipLocked`** is about the *fetch* path. By default pg-boss claims jobs with `SELECT FOR
  UPDATE SKIP LOCKED`. In some distributed engines that has problems:
  1. **Performance degradation under concurrency** — with 500 workers, mean latency for `SELECT FOR
     UPDATE SKIP LOCKED` can reach 311ms or higher ([CockroachDB #97135](https://github.com/cockroachdb/cockroach/issues/97135)).
  2. **Unexpected row skipping** — `SKIP LOCKED` can skip unlocked rows, causing workers to miss
     available work ([CockroachDB #121917](https://github.com/cockroachdb/cockroach/issues/121917)).

  With `noSkipLocked`, pg-boss instead claims jobs with an atomic `UPDATE ... RETURNING` and a
  `state < 'active'` recheck:

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
    AND j.state < 'active'  -- recheck for concurrent safety
  RETURNING j.*
  ```

  See [Andrew Werner's article on distributed work queues](https://dev.to/ajwerner/quick-and-easy-exactly-once-distributed-work-queues-using-serializable-transactions-jdp)
  for the pattern. The trade-off: under high contention multiple workers' CTEs may select the same
  candidate rows, all attempt the `UPDATE`, one wins, and the rest receive empty results and poll
  again. That is acceptable when processing time >> fetch time (typical for job queues).

- **`noMultiMutationCte`** is about the *write* path. pg-boss's `complete`, `fail`, and supervisor
  expiry normally run as a single CTE that mutates more than one table at once (e.g. completing a
  job and unblocking its flow dependents). CockroachDB rejects this with `multiple mutations of the
  same table "job" are not supported`. With `noMultiMutationCte`, those operations run as separate
  statements inside one transaction instead, so a job can't be lost between them.

Only `SKIP LOCKED` is replaced in the fetch path — other operations still use ordinary
`SELECT ... FOR UPDATE` (without `SKIP LOCKED`), which distributed engines support fine.

A third CockroachDB quirk — it returns integer columns (`INT8`) as text — is handled separately:
pg-boss `Number()`-coerces the numeric job and queue fields on read **whenever `backend ===
'cockroachdb'`**, not via a compatibility flag. It's a wire-format property of the database, so it's
keyed on the backend identity rather than piggybacking on a behavioral flag. (Stock Postgres returns
these as `int4` numbers, so no coercion is needed there.)

### Transaction isolation

For optimal correctness with `noSkipLocked`, SERIALIZABLE isolation ensures exactly-once job
processing — the recommended level for distributed work queues. With READ COMMITTED (PostgreSQL or
YugabyteDB defaults), the `state < 'active'` recheck in the `UPDATE` still prevents duplicate claims.

## Database compatibility

Selecting `backend` applies the ✅ behavior below for you — the flag columns are internal and shown
only so you can see what each backend does differently from stock PostgreSQL.

| Database | Status | `backend` | no&shy;SkipLocked | noMulti&shy;MutationCte | noTable&shy;Partitioning | noDeferrable&shy;Constraints | noAdvisory&shy;Locks | noCovering&shy;Indexes |
|----------|--------|-----------|:---:|:---:|:---:|:---:|:---:|:---:|
| PostgreSQL | Tested | `postgres` | | | | | | |
| CockroachDB | Tested | `cockroachdb` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| YugabyteDB | Partial¹ (tested) | `yugabytedb` | | | ✅ | | ✅ | |
| Citus | Tested (full suite) | `citus` | ² | ² | | | | |
| PGlite | Tested | `pglite` | | | | | | |
| Aurora DSQL | Not supported³ | *(none)* | | | | | | |
| Spanner | Not supported³ | *(none)* | | | | | | |

¹ YugabyteDB runs the standard fetch path; non-partitioned queueing works, but partitioned queues,
multi-master startup, and live migrations fail ([#21833](https://github.com/yugabyte/yugabyte-db/issues/21833)). See below.

² With the default coordinator-local table Citus behaves like plain PostgreSQL and needs nothing.
Only a deliberately sharded job table would need the CockroachDB-style fetch/mutation behavior — see
[Citus](#tested-citus-compatible-in-standard-mode).

³ No `backend` profile yet, so they can't be configured — see [Aurora DSQL](#not-supported-aurora-dsql)
and [Spanner](#not-supported-spanner).

### Tested: PostgreSQL

PostgreSQL is the primary supported database with full feature support. Use standard mode — no
special options needed.

### Tested: CockroachDB

CockroachDB needs every compatibility behavior; the `cockroachdb` profile turns them all on:

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://root@localhost:26257/pgboss',
  backend: 'cockroachdb'
})
```

Internally that enables atomic-`UPDATE` fetch (`noSkipLocked`), split-statement mutations
(`noMultiMutationCte`), a non-partitioned table (`noTablePartitioning`), non-deferrable constraints
(`noDeferrableConstraints`), no advisory locks (`noAdvisoryLocks`), no covering-index `INCLUDE`
(`noCoveringIndexes`), and numeric coercion on read — see
[what each backend changes internally](#what-each-backend-changes-internally).

**Because `cockroachdb` disables table partitioning:**
- Queue-level partitioning (`partition: true` on `createQueue`) is not supported
- All jobs are stored in a single table instead of per-queue partitions

CockroachDB uses a [different partitioning model](https://www.cockroachlabs.com/docs/stable/partitioning)
that requires partition columns in the PRIMARY KEY and partitions defined inline at table creation.

In `noMultiMutationCte` mode the supervisor's expiry (`failJobsByTimeout` / `failJobsByHeartbeat`)
uses CockroachDB-safe split statements instead of the multi-mutation `failJobs()` CTE (which
CockroachDB rejects), so timed-out and heartbeat-timed-out jobs are correctly moved to
`retry`/`failed` rather than stranded in `active`. Separately — keyed on `backend === 'cockroachdb'`
rather than a flag — numeric job and queue fields (including `heartbeatSeconds`) are coerced back to
numbers on read, because CockroachDB returns integers as text.

**Verified on CockroachDB** (full-suite run, PostgreSQL-only tests skipped): job send/fetch,
complete, fail (by id), retry of an explicitly failed job (including exponential backoff and
`retryDelayMax`), maintenance expiration of timed-out jobs (`expireInSeconds`), heartbeat config +
heartbeat-timeout (`heartbeatSeconds`), queue policies (`short`/`singleton`/`stately` with
`partition: false`), throttle/debounce, deferral, cancellation, and flow dependency
blocking/unblocking — including a blocking parent that fails and retries.

#### Testing the runtime toggles

`noSkipLocked` and `noMultiMutationCte` are pure runtime behaviors (no schema impact) that work on
plain PostgreSQL, so the project exercises them two ways:

- **`npm run test:distributed`** — runs the **entire** test suite on Postgres with
  `DISTRIBUTED=true`, which makes `test/testHelper.ts`'s `getConfig()` set the internal
  `__test__distributed` hook for every test (forcing `noSkipLocked` + `noMultiMutationCte` on top of
  the plain-Postgres schema, since the flags are not publicly configurable). This is the primary
  safety net: any new test is automatically exercised against the distributed code paths, fast and
  reliably, without paying CockroachDB's slow per-test DDL. It runs as its own CI job.
- **`npm run test:cockroachdb`** — runs `test/distributedDatabaseTest.ts` against a real CockroachDB
  cluster (`DB_TYPE=cockroachdb`, which also enables the compatibility flags above). A focused smoke
  test confirming actual CockroachDB compatibility; runs on every push/PR.
- **`npm run test:cockroachdb:full`** — runs the **entire** suite against a real CockroachDB cluster
  (`--no-file-parallelism`). This is the compatibility-matrix / regression signal. It's slow —
  CockroachDB rebuilds the schema per test and pays ~8–19s of online schema changes each — so it
  runs **nightly and on demand** (`workflow_dispatch`) rather than gating PRs. The per-test timeout
  is raised automatically under CockroachDB (see `vitest.config.ts`).

For tests that depend on PostgreSQL-only features (table partitioning, covering indexes, or an exact
PostgreSQL schema/migration shape), `test/testHelper.ts` exports `itPostgresOnly` /
`describePostgresOnly`, which skip under CockroachDB. For data-driven tests that loop over
`partition: true`/`false`, narrow the cases with `helper.isCockroachDb`.

`test/distributedDatabaseTest.ts` holds the invariants the general suite cannot express
(concurrent-fetch deduplication, `failDistributed`/`completeDistributed` composition inside a caller
transaction, and the compatibility-flag construction paths). Those cases force distributed runtime
via `__test__distributed` (or select `backend: 'cockroachdb'` for the schema-construction case), so
they run in every mode.

### Partially compatible: YugabyteDB

YugabyteDB is a PostgreSQL-compatible distributed database (reports as PostgreSQL 15). pg-boss has
been tested against a single-node YugabyteDB (`docker compose -f docker-compose.yugabyte.yaml up -d`,
`npm run test:yugabytedb:full`). Basic queueing works, but there is a significant caveat.

**Use `backend: 'yugabytedb'`** — it enables `noAdvisoryLocks` + `noTablePartitioning` and keeps the
standard fetch mode. YugabyteDB does **not** need `noSkipLocked` or `noMultiMutationCte` (it has
neither CockroachDB's `SKIP LOCKED` issues nor the multi-mutation CTE restriction). With this
backend, standard (non-partitioned) queueing works: send / fetch / complete, retries, job
expiration, flows, and queue policies (`short` / `singleton` / `stately`).

```typescript
const boss = new PgBoss({
  connectionString: 'postgresql://localhost:5433/pgboss',
  backend: 'yugabytedb'
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

Run it yourself: `docker compose -f docker-compose.citus.yaml up -d` then `npm run test:citus:full`.

**The one caveat is opt-in.** If you deliberately shard the pg-boss job table with
`create_distributed_table()`, `SELECT FOR UPDATE SKIP LOCKED`
[only works for single-shard queries](https://docs.citusdata.com/en/stable/develop/reference_workarounds.html)
— so a *distributed* job table would need the CockroachDB-style atomic-`UPDATE` fetch, which the
`citus` profile does not enable. There is no profile for sharded Citus today; a **reference table**
(replicated to all nodes) or the default coordinator-local table both work with `backend: 'citus'`.

### PGlite (embedded)

[PGlite](https://pglite.dev) is a complete PostgreSQL build packaged as a WASM library that runs
embedded in your Node.js (or browser) process — no separate database server. Because PGlite is real
PostgreSQL, pg-boss runs against it with **no compatibility flags**: declarative partitioning,
deferrable constraints, advisory locks, covering indexes, `SELECT FOR UPDATE SKIP LOCKED`, and the
multi-statement migration DDL all work. It is **not** a distributed backend — it is embedded
single-connection PostgreSQL, reached through the `@electric-sql/pglite` client rather than the `pg`
connection pool, via the `fromPglite` adapter.

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

#### Lifecycle is yours to manage

Unlike the default `pg`-pool connection, pg-boss does **not** open or close the PGlite instance —
you own it. Construct it before `boss.start()` and close it after `boss.stop()`:

```ts
await boss.stop()
await pglite.close()
```

This mirrors the [ORM transaction adapters](api/adapters.md): pg-boss only calls `executeSql` on the
object you provide.

#### Single-connection considerations

PGlite serializes everything through one connection. pg-boss's background loops (maintenance,
scheduling, monitoring) and your workers all share that single connection, so queries are processed
one at a time. This is fine functionally — PGlite queues requests internally — but you should keep
concurrency modest:

- There is no benefit to large `batchSize` or many concurrent workers; they cannot run in parallel.
- For embedded / local-first / testing workloads (PGlite's sweet spot) this is rarely a constraint.
- For high-throughput multi-worker queues, use a server-based PostgreSQL instead.

#### Persistence

PGlite supports in-memory, IndexedDB (browser), and filesystem persistence — see the
[PGlite docs](https://pglite.dev/docs/filesystems). pg-boss treats all of them identically; the job
schema and data persist wherever the PGlite instance stores its data directory.

### Not supported: Aurora DSQL

There is no `backend` profile for Aurora DSQL, so pg-boss cannot currently be configured to run
against it. The notes below are for contributors evaluating a future profile.

[Amazon Aurora DSQL](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html)
is a serverless distributed SQL database with PostgreSQL compatibility. However, it uses
[optimistic concurrency control (OCC)](https://aws.amazon.com/blogs/database/concurrency-control-in-amazon-aurora-dsql/)
instead of traditional pessimistic locking, which fundamentally changes how locking works.

**Feature support:**
- Table partitioning: ❌ [Not supported](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-migration-guide.html) — Aurora DSQL auto-manages distribution
- Foreign key constraints: ❌ Not supported
- Deferrable constraints: ❌ N/A (no FK constraints)
- Advisory locks: ❌ Not supported (OCC model)
- Covering indexes (INCLUDE): ✅ Supported
- Synchronous CREATE INDEX: ❌ Only [`CREATE INDEX ASYNC`](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html) supported

**Key concerns:**
1. **OCC vs pessimistic locking**: `SELECT FOR UPDATE` in Aurora DSQL doesn't lock rows — it flags
   them for conflict detection at commit time. `SKIP LOCKED` is not meaningful in this model.
2. **Async-only index creation**: pg-boss uses synchronous `CREATE INDEX` during schema migrations.
   Aurora DSQL only supports `CREATE INDEX ASYNC`, which may cause migration failures.
3. **Retry logic required**: OCC returns serialization errors on conflict instead of blocking.
   Applications must implement retry logic.

**A profile would need** the CockroachDB-style behavior — `noSkipLocked` (OCC doesn't support
`SKIP LOCKED` semantics), `noMultiMutationCte`, `noTablePartitioning`, `noDeferrableConstraints`, and
`noAdvisoryLocks` — but compatibility is **uncertain** regardless, because of async-only index
creation and OCC behavior. If you experiment with Aurora DSQL, please report your findings.

### Not supported: Spanner

There is no `backend` profile for Spanner, so it cannot currently be configured. **Spanner (with
PGAdapter)** — Google Cloud Spanner provides PostgreSQL wire compatibility via
[PGAdapter](https://cloud.google.com/spanner/docs/pgadapter). A profile would likely need
`noSkipLocked`, `noMultiMutationCte`, `noTablePartitioning`, `noDeferrableConstraints`, and
`noAdvisoryLocks` like CockroachDB, but Spanner's more limited PostgreSQL support may pose other
incompatibilities. If you experiment with Spanner, please report your findings.

## Scaling beyond a single table

For very high-throughput workloads (thousands of jobs per second), `noSkipLocked` alone may not be
sufficient. At scale, contention on the job table becomes a bottleneck regardless of the fetch
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
to distribute write load across ranges. This helps avoid hotspots when inserting time-ordered jobs.

### When to use alternative systems

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
- PostgreSQL job queues: 7–30k jobs/sec ([benchmarks](https://gist.github.com/chanks/7585810), [Tembo MQ](https://legacy.tembo.io/blog/mq-stack-benchmarking/))
- Kafka: 1–2M messages/sec ([LinkedIn](https://engineering.linkedin.com/kafka/benchmarking-apache-kafka-2-million-writes-second-three-cheap-machines), [Honeycomb](https://developer.confluent.io/learn-more/podcasts/handling-2-million-apache-kafka-messages-per-second-at-honeycomb/))
- Redis Streams: 1–7M messages/sec ([benchmarks](https://goatreview.com/building-a-high-performance-message-queue-with-redis-streams/))

## Known limitations and race conditions

These apply when running with `noSkipLocked` (the atomic-UPDATE fetch path).

### Cache staleness

pg-boss caches queue metadata (including active singleton keys) with a configurable refresh interval
(`queueCacheIntervalSeconds`, default 60s). Under high concurrency:

- Two workers may both see stale cache showing no active singletons
- Both attempt to claim jobs with the same singleton key
- The `state < 'active'` recheck prevents duplicate claims, but one worker receives empty results

This is a performance issue, not a correctness issue — no job is processed twice.

### Serialization errors (CockroachDB)

CockroachDB uses SERIALIZABLE isolation by default. Under high contention, transactions may fail with
serialization errors and need to retry. pg-boss's fetch operation treats all errors as "no jobs
available" and returns empty results; the worker retries on the next poll cycle.

### Empty results under contention

With `noSkipLocked`, when multiple workers fetch concurrently:

1. All workers' CTEs may select the same candidate jobs (no row locking)
2. All workers attempt the `UPDATE`
3. One succeeds, the others fail the `state < 'active'` recheck
4. Failed workers receive empty results

This is the documented trade-off. For job queues where processing time >> fetch time, this is
acceptable — workers simply poll again.

### Compatibility notes

- All pg-boss features (priorities, groups, singletons, retries, etc.) work on every backend.
- The atomic-`UPDATE` fetch (`noSkipLocked`) offers no benefit on stock PostgreSQL — under contention
  workers receive empty results instead of efficiently skipping to unlocked rows — which is why it is
  only enabled for backends that need it, never on `backend: 'postgres'`.
