# Partition Removal Plan

Plan for removing PostgreSQL table-partitioning support from bun-boss entirely.

> Historical planning document: written before the fork dropped the CockroachDB/YugabyteDB/Citus
> profiles and their migration/CLI machinery, so backend names and some file references describe
> the codebase as it was then.

## TL;DR

- **Two things are partitioned today:** the `job` table (`PARTITION BY LIST (name)` — a
  `job_common` DEFAULT partition plus one dedicated `j<hash>` table per queue created with
  `partition: true`) and the `queue_stats` table (`PARTITION BY RANGE (captured_on)` — daily
  partitions).
- **The target shape already exists.** The internal `noTablePartitioning` flag already renders a
  complete, tested non-partitioned schema — a single plain `job` table, indexes directly on it,
  `DELETE`-based stats retention. CockroachDB, YugabyteDB, PGlite-distributed and SQLite all run
  it in production. So *removing* partitioning = making that path the only path.
- **The hard part is not the code deletion — it's the one-way data migration** that collapses an
  existing partitioned install (potentially millions of rows across many child tables, under
  exclusive locks) into the single-table shape, landing byte-identical to a fresh non-partitioned
  install so drift detection passes.
- **Recommended shape: phased**, not a hard cutover. Freeze new partitions → ship the collapse
  migration (read-path stays during a deprecation window) → delete the partitioned code in a later
  major.

## Decisions to lock before starting

1. **Phased vs hard cutover.** Recommend **phased** (below). A hard cutover couples an irreversible
   data migration to code deletion in one release, with no safe fallback if the migration misbehaves.
2. **In-place migration vs require-drain.** Recommend **offer an in-place collapse migration** but
   document it as requiring a maintenance window; also document the cheaper "drain all queues to
   empty, then upgrade" path for installs that can afford downtime instead of a data copy.
3. **Vestigial `queue.partition` / `queue.table_name` columns.** After removal both are constant
   (`false` / `'job'`). Recommend **keep them initially** (fewer schema diffs, lower migration risk)
   and drop them in a separate later cleanup migration.
4. **Fold away newly-moot flags.** Removing partitioning also makes `noDeferrableConstraints` moot
   (the deferrable FK only ever existed on the partitioned shape) and `noCoveringIndexes` is already
   moot. Optional follow-up cleanup, not required for correctness.
5. **Upstream divergence — needs explicit sign-off.** Partitioning is upstream (`timgit/pg-boss`)
   core. Removing it is a large, permanent divergence that will make future upstream merges much
   harder, directly against the fork's "keep diffs small and mergeable" directive. This is a
   strategic call, not just an engineering one.

## Phase 1 — Freeze new partitioning (API + defaults)

Goal: stop creating *new* partitioned structures; keep reading existing ones.

- **`attorney.ts`** — reject or warn-and-ignore `partition: true` on `createQueue`/`work` options
  (`validateQueueArgs`). New queues always land in the shared table.
- **`attorney.ts` (`resolveBackend`)** — make the stock `postgres` profile render the non-partitioned
  shape (either set `noTablePartitioning` on it, or — better, since this is the end state — start
  collapsing the branches). New Postgres installs come up single-table.
- **Runtime read-path stays intact** — `getQueueCache` still resolves `table_name` to `job_common`
  or `j<hash>` for queues that already live there, so existing installs keep working until migrated.
- **Docs** — mark `partition` deprecated in `docs/api/queues.md` and `docs/api/constructor.md`.

## Phase 2 — The collapse migration (the crux)

A new migration `version: 38` in `migrationStore.ts`, **Postgres-only**, gated so
`noTablePartitioning` backends (Cockroach/Yugabyte/SQLite) no-op (they never partitioned).

Fresh installs are unaffected — `contractor.create()` calls `plans.create()` at the target version
and already emits the non-partitioned shape; only upgrades of a *partitioned* database run this.

**`job` table collapse** (target: all rows in a single plain table named `job`, matching a fresh
non-partitioned install):

1. `ALTER TABLE <schema>.job DETACH PARTITION <schema>.job_common;` — `job_common` becomes a
   standalone table holding all non-partition queues' rows.
2. For each dedicated partition `t` (enumerate via `queue WHERE partition = true`, i.e.
   `getPartitionedQueueTables`): `DETACH PARTITION t` → `INSERT INTO job_common SELECT * FROM t` →
   `DROP TABLE t`. **This copy is the expensive, lock-heavy step** — worst on exactly the
   high-volume queues partitioning was adopted for.
3. Drop the now-empty partitioned parent `job` (after verifying nothing else depends on it).
4. `ALTER TABLE <schema>.job_common RENAME TO job;`
5. **Reconcile indexes, PK, FKs, and CHECK constraints** on the renamed table to the exact
   names/shapes a fresh non-partitioned install produces (`job_i1`..`job_i8`, `q_fkey`/`dlq_fkey`
   **non-deferrable**, drop the per-partition `cjc` name-check). Getting this byte-identical is what
   makes `detectSchemaDrift` pass afterward.
6. `UPDATE <schema>.queue SET partition = false, table_name = 'job';`

**`queue_stats` collapse** (RANGE-by-day → single table): same detach/copy/swap, then switch
retention from `DROP … PARTITION` to `DELETE` (the `noTablePartitioning` path already does this in
`boss.ts`).

**Function swap:** drop the partitioned `create_queue`/`delete_queue` and the
`job_table_format` / `job_table_run` / `job_table_run_async` helpers; install the non-partitioned
`create_queue`/`delete_queue` bodies.

**Risks / properties:**

- **Not online.** Steps 1–5 take `ACCESS EXCLUSIVE` locks and copy data — needs a maintenance
  window. A batched/`CONCURRENTLY` variant via BAM could reduce lock time but is substantially more
  work; scope explicitly.
- **Effectively one-way.** `uninstall`/rollback cannot losslessly re-shard rows back into per-queue
  partitions. Document v38 as irreversible and **require a backup first**.
- **Historical migrations stay immutable.** Do **not** edit the partition DDL embedded in v26–v37 —
  installs upgrading from old versions still replay them on the way to v38. v38 is what undoes the
  partitioned shape at the end.

## Phase 3 — Delete the partitioned code (mechanical, later release)

Only after the migration has shipped and a deprecation window has passed. Every surface, with refs:

- **`plans.ts`** (heaviest — ~109 refs): remove the `PARTITION BY LIST/RANGE` clauses, `createTableJobCommon`,
  `jobTableFormatFunction`/`jobTableRunFunction`/`jobTableRunAsyncFunction`, `ensureQueueStatsPartitions`,
  `dropOldQueueStatsPartitions`, the partitioned `create_queue`/`delete_queue` bodies,
  `getPartitionedQueueTables`, `getManagedQueuePartitions`, the `truncateTable` partition branch, and
  collapse every `noTablePartitioning ? … : …` to the non-partitioned side.
- **`attorney.ts`**: drop the `partition` option, remove `noTablePartitioning` from `BACKEND_PROFILES`
  and the flag list.
- **`types.ts`**: remove `partition` from queue options, remove `noTablePartitioning`, fix the
  `UpdateQueueOptions = Omit<Queue, 'name' | 'partition' | 'policy'>` omit list.
- **`manager.ts`**: `getQueueCache().table` is always `'job'`; collapse the `deleteQueue`/`purgeQueue`
  `partition ? truncate : delete` branch (`manager.ts:1989`).
- **`boss.ts`**: remove the `ensureQueueStatsPartitions` calls and the
  `dropOldQueueStatsPartitions` branch (`boss.ts:156`, `boss.ts:176`).
- **`contractor.ts`**: drop `noPartitioning` from `getAll`; simplify the drift probe that keys on
  `job_common` presence (`contractor.ts:134`); drop `partitionTables` plumbing.
- **`cli.ts`**: remove `getPartitionTables` and all `partitionTables` args (~18 refs).
- **`index.ts`**: drop `partitionTables` from `getMigrationPlans`; update the YugabyteDB warning text
  that mentions partitioned queues (`index.ts:196`).
- **`navigator.ts`**, **`drifter.ts`**: remove the partition-leaf handling.
- **`migrationStore.ts`**: remove `inlineAsyncCommand`'s partition fan-out and the `noPartitioning`
  branches in `getAll` — but keep historical migration bodies intact (see Phase 2 note).
- **`scripts/gen-manifest.ts` + `src/schema.json`**: gen-manifest currently emits *both* partitioned
  and non-partitioned shapes; drop the partitioned shape, then `bun run gen:manifest` and commit
  (`gen:manifest:check` gates CI).
- **Optional flag cleanup**: fold away `noDeferrableConstraints` (now always non-deferrable) and the
  already-moot `noCoveringIndexes`.

## Phase 4 — Tests & docs

- **Snapshots**: regenerate `test/plansSnapshot.sql` / `plansSnapshotTest.ts` (57 partition refs) —
  the postgres output is pinned byte-for-byte, so these must be updated deliberately.
- **Partition-specific tests**: prune assertions in `queueTest.ts`, `queuePolicyTest.ts`,
  `keyStrictFifoTest.ts`, `queueStatsHistoryTest.ts`, `driftTest.ts`, `configTest.ts`, `cliTest.ts`,
  `noSkipLockedNoCteTest.ts` (named `distributedDatabaseTest.ts` at the time of writing).
- **New migration test**: seed a v37 database with a `job_common` default partition **and** at least
  one dedicated `j<hash>` partition holding rows, run v38, assert (a) no rows lost, (b)
  `queue.table_name = 'job'` / `partition = false`, (c) `detectSchemaDrift()` clean against the
  regenerated manifest.
- **Docs**: remove partition references from `database-backends.md`, `api/queues.md`, `cli.md`,
  `introduction.md`, `api/constructor.md`, `api/ops.md`, `api/events.md`.

## Behavioral consequences to communicate

- **No per-queue physical isolation.** A hot queue's churn again shares one table/indexes with
  everyone else.
- **Retention becomes a bulk `DELETE`, not a partition drop** — slower, and generates dead tuples /
  vacuum load on large queues. This is the same trade already documented for `noTablePartitioning`
  in `FALLBACK_REPORT.md`.
- **`partition: true` becomes an error / no-op** — a breaking API change; needs a `feat!:` /
  `BREAKING CHANGE:` commit and a major version bump.

## Verification checklist

- [ ] `bun run gen:manifest` regenerated and committed; `gen:manifest:check` green.
- [ ] `detectSchemaDrift()` clean on a database migrated v37 → v38 (with seeded dedicated partitions).
- [ ] Full suite green: `test`, `test:distributed`, `test:bun`, `test:pglite`, `test:sqlite`.
- [ ] Migration test proves row preservation + drift-clean on multi-partition seed data.
- [ ] `tsc --noEmit` clean after the `types.ts` omit/flag changes.
