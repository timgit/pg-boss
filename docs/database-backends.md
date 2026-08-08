# Database Backends

bun-boss runs on stock single-node PostgreSQL by default. It also supports the embedded WASM build
[PGlite](https://pglite.dev) and an embedded [SQLite](#sqlite-embedded-via-bunsql) backend. You
select one with the `backend` option, which applies all the compatibility behavior that backend
needs.

## Backend profiles

`backend` is the **only** option you set — it selects the database bun-boss is running against and
turns on the right combination of internal compatibility behavior for it:

```typescript
import { BunBoss } from 'bun-boss'

const boss = new BunBoss({
  url: 'postgresql://localhost:5432/pgboss',
  backend: 'postgres'
})
```

Each backend has a *kind* — `standard` (stock PostgreSQL) or `embedded` (in-process):

| `backend` | Kind | What it enables |
|-----------|------|-----------------|
| `postgres` *(default)* | standard | *(none — full PostgreSQL)* |
| `pglite` | embedded | *(none — full PostgreSQL; see [PGlite](#pglite-embedded))* |
| `sqlite` | embedded | A different SQL dialect entirely: every compatibility flag plus sqlite-rendered SQL (see [SQLite](#sqlite-embedded-via-bunsql)) |

`backend` is the only option you set — bun-boss derives everything above from it, so a deployment
can't end up with an inconsistent combination. The rest of this page explains each behavior (and
names the internal flag it maps to, for anyone reading the source).

## Database compatibility

The matrix shows which PostgreSQL features each backend supports (✅). Where a feature isn't
available (❌), bun-boss automatically switches to the compatible alternative — see the
[compatibility flags](#compatibility-flags) below.

| Database | Status | `backend` | SKIP LOCKED | Multi-mutation CTEs | Table partitioning | Deferrable constraints | Advisory locks | Covering indexes | LISTEN/NOTIFY |
|----------|--------|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| PostgreSQL | Tested | `postgres` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅² |
| PGlite | Tested | `pglite` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅¹ |
| SQLite | Tested | `sqlite` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

¹ PGlite is embedded single-connection PostgreSQL, so LISTEN/NOTIFY works entirely in-process. The
`fromPglite` adapter wires it up automatically, so `useListenNotify` works with no extra setup.

² Producer side only through the built-in driver: bun-boss still inlines `pg_notify` into inserts on
notify-enabled queues, but Bun's SQL client implements no LISTEN, so the *listener* requires a `db`
adapter that implements `listen` — see [No LISTEN/NOTIFY](#no-listennotify).

## Compatibility flags

Here's what each behavior does differently from stock PostgreSQL, and the internal flag it maps to
in the source. These flags are not user-configurable — `resolveBackend` derives them from the
`backend` profile. Today the `sqlite` profile is the one that turns them all on; the `postgres` and
`pglite` profiles leave them off.

| Capability | Effect | Trade-off | Flag |
|------------|--------|-----------|------|
| Lock-free fetch | Fetch jobs with an atomic `UPDATE ... RETURNING` (plus a `state < 'active'` recheck) instead of `SELECT FOR UPDATE SKIP LOCKED`. | Under high contention some workers get empty results instead of skipping to unlocked rows. | `noSkipLocked` |
| Split-statement writes | Run `complete`, `fail`, and supervisor expiry as split statements inside a transaction rather than a single multi-mutation CTE. | A few extra round-trips per command; negligible for normal workloads. | `noMultiMutationCte` |
| Single shared table | Create the job table without `PARTITION BY LIST`. | Per-queue partitioning (`partition: true`) is unavailable; all jobs share one table. | `noTablePartitioning` |
| Immediate constraints | Omit `DEFERRABLE INITIALLY DEFERRED` on foreign keys. | Constraints check immediately rather than at commit (no effect on normal operation). | `noDeferrableConstraints` |
| Lock-free schema setup | Disable `pg_advisory_xact_lock` (used to coordinate schema creation). | Concurrent instances may occasionally do redundant maintenance — a performance, not correctness, concern. | `noAdvisoryLocks` |
| Plain indexes | Omit the `INCLUDE` clause on covering indexes. | Slightly less efficient index-only scans during fetch; minimal for most workloads. | `noCoveringIndexes` |

Lock-free fetch and split-statement writes are **runtime** behaviors; the other four are **schema**
choices applied at install time.

### Why fetch and mutation strategy are tracked separately

`noSkipLocked` and `noMultiMutationCte` address two unrelated limitations:

- **`noSkipLocked`** is about the *fetch* path. By default bun-boss claims jobs with `SELECT FOR
  UPDATE SKIP LOCKED`. Where a backend can't rely on `SKIP LOCKED`, bun-boss instead claims jobs with
  an atomic `UPDATE ... RETURNING` and a `state < 'active'` recheck:

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
  for the pattern. The trade-off: under high contention multiple workers' CTEs may select the same
  candidate rows, all attempt the `UPDATE`, one wins, and the rest receive empty results and poll
  again. That is acceptable when processing time >> fetch time (typical for job queues).

- **`noMultiMutationCte`** is about the *write* path. bun-boss's `complete`, `fail`, and supervisor
  expiry normally run as a single CTE that mutates more than one table at once (e.g. completing a
  job and unblocking its flow dependents). Where that isn't available, those operations run as
  separate statements inside one transaction instead, so a job can't be lost between them.

Only `SKIP LOCKED` is replaced in the fetch path — other operations still use ordinary
`SELECT ... FOR UPDATE` (without `SKIP LOCKED`).

### Testing the runtime toggles

`noSkipLocked` and `noMultiMutationCte` are pure runtime behaviors (no schema impact) that work on
plain PostgreSQL, so the project exercises them independently of any embedded backend:

- **`bun run test:no-skip-locked-no-cte`** — runs the **entire** test suite on Postgres with
  `NO_SKIP_LOCKED_NO_CTE=true`, which makes `test/testHelper.ts`'s `getConfig()` set the internal
  `__test__noSkipLockedNoCte` hook for every test (forcing `noSkipLocked` + `noMultiMutationCte` on top
  of the plain-Postgres schema, since the flags are not publicly configurable). Any new test is
  automatically exercised against the atomic-`UPDATE` fetch and split-statement write paths, fast
  and reliably. It runs as its own CI job.

`test/noSkipLockedNoCte.test.ts` holds the invariants the general suite cannot express
(concurrent-fetch deduplication, `failNoCte`/`completeNoCte` composition inside a caller
transaction, and the compatibility-flag construction paths). Those cases force the runtime behavior
via `__test__noSkipLockedNoCte`, so they run in every mode.

### Transaction isolation

The `state < 'active'` recheck in the `UPDATE` guarantees exactly-once claims under READ COMMITTED
(the PostgreSQL default); bun-boss does not set or require SERIALIZABLE isolation.

## Per-database notes

Testing status, setup, and caveats for each supported backend.

### Tested: PostgreSQL

PostgreSQL is the primary supported database with full feature support. Use standard mode — no
special options needed. The built-in driver is [Bun's SQL client](#bunsql-the-built-in-driver).

### PGlite (embedded)

[PGlite](https://pglite.dev) is a complete PostgreSQL build packaged as a WASM library that runs
embedded in your process — no separate database server. Because PGlite is real PostgreSQL, bun-boss
runs against it with **no compatibility flags**: declarative partitioning, deferrable constraints,
advisory locks, covering indexes, and `SELECT FOR UPDATE SKIP LOCKED` all work. It is embedded
single-connection PostgreSQL, reached through the `@electric-sql/pglite` client rather than the
built-in Bun-SQL driver, via the `fromPglite` adapter.

#### Usage

Install PGlite alongside bun-boss:

```bash
bun add @electric-sql/pglite
```

Construct a PGlite instance, wrap it with `fromPglite`, and select the `pglite` backend profile:

```ts
import { PGlite } from '@electric-sql/pglite'
import { BunBoss, fromPglite } from 'bun-boss'

const pglite = new PGlite('idb://my-app')   // or new PGlite() for in-memory

const boss = new BunBoss({
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

Unlike the built-in driver's connection, bun-boss does **not** open or close the PGlite instance —
you own it. Construct it before `boss.start()` and close it after `boss.stop()`:

```ts
await boss.stop()
await pglite.close()
```

This mirrors the [database adapters](api/adapters.md): bun-boss only calls `executeSql` on the
object you provide.

#### Single-connection considerations

PGlite serializes everything through one connection. bun-boss's background loops (maintenance,
scheduling, monitoring) and your workers all share that single connection, so queries are processed
one at a time. This is fine functionally — PGlite queues requests internally — but you should keep
concurrency modest:

- There is no benefit to large `batchSize` or many concurrent workers; they cannot run in parallel.
- For embedded / local-first / testing workloads (PGlite's sweet spot) this is rarely a constraint.
- For high-throughput multi-worker queues, use a server-based PostgreSQL instead.

#### Persistence

PGlite supports in-memory, IndexedDB (browser), and filesystem persistence — see the
[PGlite docs](https://pglite.dev/docs/filesystems). bun-boss treats all of them identically; the job
schema and data persist wherever the PGlite instance stores its data directory.

### Bun.SQL (the built-in driver)

[Bun's built-in SQL client](https://bun.com/docs/api/sql) is bun-boss's driver for stock
PostgreSQL: it is a *driver*, not a backend, so `backend` stays at its default `postgres` and no
compatibility flags apply. Passing a connection string or connection options to the `BunBoss`
constructor builds an internal `SQL` client wrapped by the `fromBunSql` adapter; passing
`db: fromBunSql(sql)` uses a client you own instead.

#### Bun 1.3.14 minimum, 1.4 recommended

The package floor is **Bun 1.3.14**; prefer **1.4+**. On 1.3.x, a pooled connection can be handed
to a waiting query before the `ROLLBACK` clearing its aborted transaction has landed, so an
unrelated query can fail with `25P02 current transaction is aborted` whenever a transaction block
fails under concurrency — contended maintenance being the realistic trigger. The window is inside
Bun's pool and is fixed in 1.4; on 1.3.x the driver detects the aborted state, clears it, and
retries, so the failure is masked rather than eliminated. A rarer silent form of the same 1.3.x
defect can return an empty result for a committed row under concurrent load — bun-boss corroborates
queue lookups to bound it (see `ISSUES.txt` #3), but only 1.4 removes it.

Transaction-scoped use (`fromBunSql(tx)` inside `sql.begin()`) never reserves a connection and is
unaffected on either version.

#### Usage

Bun's SQL client is built in — nothing to install, and nothing to configure beyond the connection:

```ts
import { BunBoss } from 'bun-boss'

const boss = new BunBoss('postgres://user:pass@localhost:5432/mydb')

await boss.start()

await boss.createQueue('email')
await boss.send('email', { to: 'user@example.com' })
```

To share a client your application already owns (or to scope a single operation to a `sql.begin()`
transaction — see [Database Adapters](api/adapters.md#bun)), wrap it with `fromBunSql`:

```ts
import { SQL } from 'bun'
import { BunBoss, fromBunSql } from 'bun-boss'

const sql = new SQL('postgres://user:pass@localhost:5432/mydb')

const boss = new BunBoss({ db: fromBunSql(sql) })
```

With a bring-your-own client, bun-boss does **not** open or close it — construct it before
`boss.start()` and `sql.close()` it after `boss.stop()`. The built-in client's lifecycle is
bun-boss's own: it opens on `start()` and closes on `stop()`.

#### No LISTEN/NOTIFY

Bun's SQL client
[does not implement LISTEN or NOTIFY](https://bun.com/docs/api/sql#postgresql-specific-features).
The built-in driver therefore exposes no listener, and `useListenNotify: true` emits a
`listen_notify_unavailable` warning and continues with polling. Nothing is lost but wake-up latency —
a NOTIFY is only ever a hint that makes workers poll sooner, never a correctness requirement.

The producer side is unaffected: the `pg_notify` bun-boss inlines into inserts is evaluated by
PostgreSQL itself, so a queue can stay opted into `notify` and any listener on another connection
(e.g. a `fromPglite`-backed instance, or your own session holding `LISTEN`) can still act on it.

#### Keep Bun's default `prepare: true`

Bun derives each parameter's wire encoding from the type PostgreSQL reports for that placeholder,
which only happens when statements are prepared. Under `prepare: false`, an object bound to an
uncast jsonb placeholder is sent in a form PostgreSQL rejects, so that option is not supported.

Bun caches prepared statements per connection, keyed by query text. bun-boss generates its SQL per
queue table, so that cache grows with the number of partitioned queues — worth watching in
`pg_prepared_statements` on deployments with very many of them.

#### Multi-statement blocks

Schema installs and maintenance run as a single `BEGIN … COMMIT` block, which Bun refuses on a
pooled connection. The adapter replays those on a reserved connection automatically — you do not
need `max: 1`.

### SQLite (embedded, via Bun.SQL)

SQLite is the one supported backend that is **not** a Postgres-compatible engine — it is a
different SQL dialect. The `sqlite` profile enables every compatibility flag, and bun-boss renders
alternate SQL for it throughout: TEXT ISO-8601 timestamps, TEXT uuids and JSON, a
CHECK-constrained state column, `json_each` in place of arrays, and the atomic-`UPDATE` claim in
place of row locking. The only supported driver is
[Bun's built-in SQL client](https://bun.com/docs/api/sql) opened on a `sqlite://` URL, reached
through the `fromBunSqlite` adapter. Requires Bun 1.3.14+ (the package floor; Bun's sqlite support in `SQL`).

#### Usage

```ts
import { SQL } from 'bun'
import { BunBoss, fromBunSqlite } from 'bun-boss'

const sql = new SQL('sqlite://app.db')      // or 'sqlite://:memory:'

const boss = new BunBoss({
  backend: 'sqlite',
  db: fromBunSqlite(sql)
})

await boss.start()

await boss.createQueue('email')
await boss.send('email', { to: 'user@example.com' })
```

Because bun-boss's tables live in the **same database file** as your application's (namespaced by a
quoted `"schema.table"` prefix), a job enqueued inside a transaction opened through the adapter's
`withTransaction` (passed as the operation's `db`) commits atomically with your application
writes — see [Database Adapters](api/adapters.md#sqlite-bun) for the pattern.

#### Single-process, single logical connection

SQLite is a single-writer embedded database. The adapter serializes every statement and every
transaction block internally, and it enables `PRAGMA foreign_keys = ON` and a
`PRAGMA busy_timeout` on first use. Like PGlite, you own the instance lifecycle — construct the
`SQL` instance before `boss.start()` and `sql.close()` it after `boss.stop()`. Running multiple
bun-boss **processes** against the same database file is not supported; use worker concurrency
within one process instead.

#### What is different from the Postgres backends

- **Fresh installs only**: the sqlite schema installs at the current version; there is no
  migration history. Upgrading bun-boss against an older sqlite install fails with an explicit
  error until sqlite migrations ship.
- **No LISTEN/NOTIFY**: workers rely on polling (the correctness floor on every backend).
- **`findJobs({ data })`** matches shallowly: every top-level key/value in the filter must match;
  nested objects compare as JSON text rather than by deep containment.
- Relative `startAfter` strings (`'5 minutes'`) are parsed by bun-boss rather than the database;
  the supported grammar is `N unit` sequences (`seconds/minutes/hours/days/weeks`) and
  `HH:MM[:SS]`.
- **Flows** verify all-or-nothing creation in code inside a real transaction rather than via
  Postgres's statement-level error signal. A bring-your-own `IDatabase` that omits
  `withTransaction` therefore loses flow atomicity, and when a flow fails inside a caller-owned
  transaction (`{ db }`), the transaction itself stays usable — roll it back rather than
  committing after a caught flow error.

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

### When to use alternative systems

**Use bun-boss** (database-backed queue) when:
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

bun-boss caches queue metadata (including active singleton keys) with a configurable refresh interval
(`queueCacheIntervalSeconds`, default 60s). Under high concurrency:

- Two workers may both see stale cache showing no active singletons
- Both attempt to claim jobs with the same singleton key
- The `state < 'active'` recheck prevents duplicate claims, but one worker receives empty results

This is a performance issue, not a correctness issue — no job is processed twice.

### Empty results under contention

With `noSkipLocked`, when multiple workers fetch concurrently:

1. All workers' CTEs may select the same candidate jobs (no row locking)
2. All workers attempt the `UPDATE`
3. One succeeds, the others fail the `state < 'active'` recheck
4. Failed workers receive empty results

This is the documented trade-off. For job queues where processing time >> fetch time, this is
acceptable — workers simply poll again.

### Compatibility notes

- All bun-boss features (priorities, groups, singletons, retries, etc.) work on every backend.
- The atomic-`UPDATE` fetch (`noSkipLocked`) offers no benefit on stock PostgreSQL — under contention
  workers receive empty results instead of efficiently skipping to unlocked rows — which is why it is
  only enabled for backends that need it, never on `backend: 'postgres'`.
