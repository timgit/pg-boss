# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

pg-boss is a job queue for Node.js built on PostgreSQL. It relies on `SKIP LOCKED` for exactly-once delivery and stores all state (jobs, queues, schedules, archive) in a dedicated Postgres schema. The published npm package is the library in `src/`.

## Commands

Requirements: **Node ≥ 22.12** (for `require(esm)`) and **PostgreSQL ≥ 13**. Tests need a running Postgres — `docker compose up` starts one matching `test/config.json` (db `pgboss`, user/pass `postgres`).

- `npm test` — the full check: `eslint . && vitest run`. The `pretest` hook runs `prisma generate`, `tsc --noEmit`, and `gen:manifest:check` first, so a failing type-check or a stale `schema.json` fails the test command before any test runs.
- `npm test -- test/sendTest.ts` — run a single test file.
- `npm test -- -t "substring of test name"` — run tests matching a name.
- `npm run cover` — tests with V8 coverage.
- `npm run tsc` — type-check only (`tsc --noEmit`). `npm run lint:fix` — autofix lint.
- `npm run build` — clean `dist/` and compile via `tsconfig.build.json`.
- `npm run gen:manifest` — regenerate `src/schema.json` (see Schema manifest below). `gen:manifest:check` verifies it is current.

### Running against other backends

The suite is parameterized by `DB_TYPE` / `DISTRIBUTED` env vars (resolved in `test/testHelper.ts`):

- `npm run test:distributed` — `DISTRIBUTED=true`, exercises the atomic-UPDATE fetch path on plain Postgres (fast, no separate DB).
- `npm run test:pglite` — `DB_TYPE=pglite`, in-process WASM Postgres, no server. Connection-string / subprocess / multi-connection tests auto-skip.
- `npm run test:cockroachdb` / `test:yugabytedb:full` / `test:citus:full` — real distributed engines; matching `docker-compose.*.yaml` files start them. These runs auto-enable the backend's compatibility flags.

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

Anything implementing `IDatabase` (`executeSql`, optionally `withTransaction`/`listen`) can back pg-boss instead of the built-in pool — this is how jobs are created inside an existing app transaction. `src/adapters/` wraps popular ORM transaction objects (`fromDrizzle`, `fromKnex`, `fromKysely`, `fromPrisma`, `fromPglite`); `placeholders.ts` handles the `$1` vs `?` parameter-style differences between them.

## Testing conventions

- Test files are `test/**/*Test.ts`; compile-only type tests are `test/**/*TypeTest.ts` (run by vitest's `typecheck`).
- **Each test derives its own Postgres schema from `sha1(testFile + testName)`** (see `test/hooks.ts`), and that schema doubles as the queue namespace. So **leaf test names must be unique within a file** — a `globalSetup` (`checkDuplicateTestNames.ts`) statically rejects duplicates, because a collision manifests as flaky cross-test interference (especially under the single shared PGlite instance), not a clean failure.
- Use the skip helpers from `testHelper.ts` rather than raw `it` when a test depends on backend specifics: `itPostgresOnly`/`describePostgresOnly` (partitioning, covering indexes, exact PG schema shape), `itPglite`/`describePglite` (needs a real server or multiple connections).
