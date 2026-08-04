# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

pg-boss is a job queue for Node.js built on PostgreSQL. It relies on `SKIP LOCKED` for exactly-once delivery and stores all state (jobs, queues, schedules, archive) in a dedicated Postgres schema. The published npm package is the library in `src/`.

## Commands

Requirements: **Bun** (verified against Bun 1.4). The whole test suite and every `package.json` script run under Bun — `test/testHelper.ts` imports Bun's `SQL` at module load, so the suite cannot run under Node — and each script shells out to `bun`/`bunx`. The published library still targets **Node ≥ 22.12** (for `require(esm)`) and **PostgreSQL ≥ 13**. Tests need a running Postgres — `docker compose up -d db` starts one matching `test/config.json` (db `pgboss`, user/pass `postgres`).

- `bun run test` — the full check: `eslint . && bun --bun vitest run`. The `pretest` hook runs `bunx prisma generate`, `bun run tsc` (`tsc --noEmit`), and `gen:manifest:check` first, so a failing type-check or a stale `schema.json` fails the test command before any test runs.
- `bun run test -- test/sendTest.ts` — run a single test file.
- `bun run test -- -t "substring of test name"` — run tests matching a name.
- `bun run cover` — tests with V8 coverage.
- `bun run tsc` — type-check only (`tsc --noEmit`). `bun run lint:fix` — autofix lint.
- `bun run build` — clean `dist/` and compile via `tsconfig.build.json`.
- `bun run gen:manifest` — regenerate `src/schema.json` (see Schema manifest below). `gen:manifest:check` verifies it is current.

### CI

`.github/workflows/ci.yml` runs on every push to `master` and every PR, entirely under Bun (`container: oven/bun:1` — no Node toolchain). It runs the Postgres suite as a matrix (`standard` / `distributed` / `bun-driver`) against a Postgres service container, plus a separate PGlite job that needs no database.

### Running against other backends

The suite is parameterized by `DB_TYPE` / `DISTRIBUTED` env vars (resolved in `test/testHelper.ts`):

- `bun run test:distributed` — `DISTRIBUTED=true`, exercises the atomic-UPDATE fetch path on plain Postgres (fast, no separate DB).
- `bun run test:bun` — `DB_TYPE=bun`, routes the whole suite through the `fromBunSql` adapter (Bun's built-in `SQL` client) against the same Postgres server, so the adapter's parameter-binding workarounds are exercised by every query rather than only the dedicated adapter tests.
- `bun run test:pglite` — `DB_TYPE=pglite`, in-process WASM Postgres, no server. Connection-string / subprocess / multi-connection tests auto-skip.
- `bun run test:cockroachdb` / `test:yugabytedb:full` / `test:citus:full` — real distributed engines; matching `docker-compose.*.yaml` files start them. These runs auto-enable the backend's compatibility flags.

`vitest.config.ts` raises the per-test timeout to 60s for cockroach/yugabyte (their online-DDL cost blows the 10s Postgres budget).

## Architecture

### Component composition

`src/index.ts` defines the public `PgBoss` class (an `EventEmitter`). It does almost no work itself — the constructor builds a set of collaborator objects, all sharing one `IDatabase` and one resolved config, and public methods delegate (mostly to `Manager`). Each collaborator is itself an `EventEmitter`; `#promoteEvents` re-emits their events on the `PgBoss` instance, which is how `error`/`warning`/`wip`/`flow`/`bam` surface to the user.

- **`manager.ts`** — the core (largest file). All job operations: `send`/`insert`/`fetch`/`work`/`complete`/`fail`/`cancel`/`retry`, queue CRUD, pub/sub, stats. Owns the `Worker` instances created by `work()`.
- **`boss.ts`** — the background **supervisor**. A timer (`superviseIntervalSeconds`) drives `supervise()`, which per queue-table monitors backlog, fails timed-out/heartbeat-stale jobs, maintains partitions, and prunes archived jobs / old stats / warnings.
- **`contractor.ts`** — schema **install and migration** on `start()`. Reads the target version from `package.json` → `pgboss.schema`, compares against the installed version, and migrates. Also exposes the static `getConstructionPlans`/`getMigrationPlans`/`getRollbackPlans` used by the CLI and `index.ts`.
- **`timekeeper.ts`** — **cron scheduling** (via `cron-parser`); enqueues due scheduled jobs and watches for clock skew.
- **`navigator.ts`** — background **flow / job-dependency resolver**. Off-hot-path: audits completed "blocking" parents and unblocks children (job completion itself stays join-free for speed).
- **`bam.ts`** — background **async-migration worker** ("build a migration"). Processes queued long-running DDL (e.g. `CREATE INDEX CONCURRENTLY`) so schema upgrades don't block `start()`.
- **`notifier.ts`** — **LISTEN/NOTIFY** listener lifecycle. A NOTIFY is only ever a *latency hint* that wakes workers to poll sooner; if the listener can't be established, it warns and falls back to polling. Never required for correctness.
- **`worker.ts`** — the per-`work()` polling loop. Resolves its next delay each iteration (burst / notify-backstop / base poll) and can be woken early by `notify()`.
- **`db.ts`** — the default `IDatabase` backed by a `pg.Pool`. Implements `executeSql`, `withTransaction`, and a self-healing session-pinned `listen()` (dedicated `pg.Client`, TCP keepalive + same-session heartbeat, capped-backoff reconnect).

### plans.ts is the single source of truth for SQL

Every SQL string and all DDL lives in **`src/plans.ts`** (plus migration deltas in `migrationStore.ts`). Components never inline SQL — they call a `plans.*` builder and pass the result to `db.executeSql`. When changing behavior that touches the database, change it in `plans.ts`.

`src/schema.json` is a **generated** catalog snapshot of a freshly-created schema (both partitioned and non-partitioned shapes). `scripts/gen-manifest.ts` builds it by creating the schema on an in-memory PGlite and introspecting it with the same queries `drifter.ts` uses at runtime. Consequences:

- After **any** DDL change in `plans.ts`, run `npm run gen:manifest` — CI (`gen:manifest:check`) fails the build otherwise. Never hand-edit `schema.json`.
- `drifter.ts` powers `boss.detectSchemaDrift()` by diffing a live database against this manifest.

### Backend compatibility flags

pg-boss targets stock Postgres plus Postgres-compatible engines (CockroachDB, YugabyteDB, Citus) and embedded PGlite. `attorney.ts` (`resolveBackend`) maps a `backend` profile to a set of internal `noXxx` compatibility flags — e.g. `noSkipLocked`, `noMultiMutationCte`, `noTablePartitioning`, `noAdvisoryLocks`, `noListenNotify`, `noCoveringIndexes`, `noIndexProgressView`. These flags are **not user-configurable**; they are derived from the profile and thread through `plans.ts`, `manager.ts`, and `boss.ts` to select alternate query strategies (e.g. the split select/delete/re-insert path when `noMultiMutationCte`, atomic-UPDATE fetch when `noSkipLocked`). When touching a query, check whether it has a distributed/no-flag variant.

Distributed backends return integer columns as **strings**; `manager.ts` and `boss.ts` coerce known numeric fields with `Number()`. Watch for this when adding numeric metadata columns — a bare `>` compares lexicographically otherwise.

### Config resolution

`attorney.ts` is the validation/normalization layer. `getConfig` resolves constructor options (and the backend); the `check*` functions validate `send`/`work`/`schedule`/queue options before they reach `manager.ts`. User input is validated here, not deeper in.

### Bring-your-own database & ORM adapters

Anything implementing `IDatabase` (`executeSql`, optionally `withTransaction`/`listen`) can back pg-boss instead of the built-in pool — this is how jobs are created inside an existing app transaction. `src/adapters/` wraps popular ORM transaction objects (`fromDrizzle`, `fromKnex`, `fromKysely`, `fromPrisma`, `fromPglite`, `fromBunSql`); `placeholders.ts` handles the `$1` vs `?` parameter-style differences between them.

`fromBunSql` is the one adapter that also replaces the pool outright, and it carries workarounds for four Bun behaviors that differ from node-postgres: the SQLSTATE arrives on `err.errno` rather than `err.code` (which `manager.ts` keys real behavior on), JSON parameters are re-encoded from pg-boss's already-serialized payloads, JS arrays are not bound as postgres arrays, and `BEGIN … COMMIT` blocks are refused on a pooled connection. `DB_TYPE=bun` (`bun run test:bun`) runs the whole suite through it.

## Testing conventions

- Test files are `test/**/*Test.ts`; compile-only type tests are `test/**/*TypeTest.ts` (run by vitest's `typecheck`).
- **Each test derives its own Postgres schema from `sha1(testFile + testName)`** (see `test/hooks.ts`), and that schema doubles as the queue namespace. So **leaf test names must be unique within a file** — a `globalSetup` (`checkDuplicateTestNames.ts`) statically rejects duplicates, because a collision manifests as flaky cross-test interference (especially under the single shared PGlite instance), not a clean failure.
- Use the skip helpers from `testHelper.ts` rather than raw `it` when a test depends on backend specifics: `itPostgresOnly`/`describePostgresOnly` (partitioning, covering indexes, exact PG schema shape), `itPglite`/`describePglite` (needs a real server or multiple connections).
