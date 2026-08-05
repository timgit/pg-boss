# Fallback Report

When a backend can't do something stock Postgres does, `attorney.ts` sets a `noXxx`
flag and bun-boss selects an alternate query strategy. Each keeps **correctness**; the
cost is throughput, latency, or scalability. Summary of every fallback:

| Flag | PG feature dropped | Workaround | What it costs |
|---|---|---|---|
| **noSkipLocked** | `SELECT … FOR UPDATE SKIP LOCKED` for job claiming | Omit the lock clause; add a `state < active` guard in the WHERE and re-check it in the UPDATE so two workers can't double-claim (`plans.fetchNextJob`) | Under high contention workers get fewer jobs per fetch — some fetches return empty as concurrent updates collide. Efficiency loss, not correctness. |
| **noMultiMutationCte** | One CTE mutating several tables in a single statement (complete/fail touch job + dependents) | Split into separate statements inside one transaction (fail = select→delete→re-insert); dependency unblocking moved out-of-band to the Navigator background resolver (`manager.ts`, `boss.ts`) | More round-trips per complete/fail; flow/`onComplete` unblocking becomes eventually-consistent instead of atomic on completion. |
| **noTablePartitioning** | Declarative partitioning (per-queue job partitions, daily stats partitions) | Single unpartitioned `job` table; stats pruned with `DELETE … WHERE` instead of `DROP PARTITION`; partition-helper functions skipped (`plans.create`, `boss.ts`) | No per-queue physical isolation; retention pruning is row-delete (slower, bloat) not an instant partition drop. Loses partition-level scale. |
| **noDeferrableConstraints** | `DEFERRABLE INITIALLY DEFERRED` on the job→queue FK | Plain, immediately-checked FK (`createQueueForeignKeyJob`) | Effectively none — FK is enforced per-row at statement time rather than at commit. Bundled with the non-partitioned shape. |
| **noAdvisoryLocks** | `pg_advisory_xact_lock` serializing migrations, create/delete-queue, stats cache | Drop the lock; rely on the wrapping transaction + idempotent DDL (`IF NOT EXISTS` / `ON CONFLICT`) (`plans.locked`) | Concurrent schema/maintenance ops from multiple instances can race — risk of transient contention errors instead of clean serialization. |
| **noCoveringIndexes** | Covering-index `INCLUDE` payload | Plain index, no INCLUDE (`createIndexJobFetch`) | Nothing. The fetch's `FOR UPDATE SKIP LOCKED` forces heap access, so an index-only scan was impossible anyway; the INCLUDE was confirmed dead weight and dropped for all backends. Flag is now moot. |
| **noListenNotify** | `LISTEN`/`NOTIFY` waking idle workers the moment a job is queued | Skip the listener, emit a warning, poll only (`notifier.ts`) | Pure latency: workers pick up jobs on their next poll tick, not near-instantly. No correctness impact — NOTIFY is only ever a latency hint. |
| **noIndexProgressView** | `pg_stat_progress_create_index` for BAM to gauge a live `CREATE INDEX CONCURRENTLY` | Timeout-only reclaim; skip the INVALID-index heal/drop (distributed engines roll interrupted builds back) (`bam.ts`) | A stalled index build is reclaimed only after a timeout, not promptly by liveness; no self-heal of leftover invalid indexes. |

**Who trips which:** CockroachDB and SQLite set all eight; YugaByteDB sets
`noAdvisoryLocks` + `noTablePartitioning` + `noIndexProgressView`; Citus and PGlite
set none.
