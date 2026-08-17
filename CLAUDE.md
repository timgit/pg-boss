# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is **bun-boss** (`origin` = `khromov/bun-boss`), an experimental Bun-first fork of pg-boss. `upstream` is `timgit/pg-boss`, which is where the core still comes from — keep diffs against it small and mergeable unless a change is specifically part of the fork's direction.

The library itself is a job queue built on PostgreSQL: it relies on `SKIP LOCKED` for exactly-once delivery and stores all state (jobs, queues, schedules, job dependencies) in a dedicated Postgres schema. The package in `src/` is the whole product.

## Naming: renamed above the database line, unchanged below it

The rename has happened, but only down to the database boundary. The npm package is `bun-boss`, the exported class is `BunBoss` (named export — there is no default export), the `package.json` schema-version key is `bunboss`, and the connection `application_name` defaults to `bunboss`. The **prefix**-mode default namespace (`plans.ts` `DEFAULT_PREFIX = 'bunboss'`, see `tableIsolation` below) is also above the line.

**The `pgboss` name still governs `tableIsolation: 'schema'` (the default mode) on-disk state and cross-instance coordination, and must stay that way** — renaming any of it orphans existing schema-mode installs:

- `plans.ts` `DEFAULT_SCHEMA = 'pgboss'` — the default schema holding every table in schema mode. (Prefix mode's default namespace is `DEFAULT_PREFIX = 'bunboss'`, a fork-only facility with no upstream history, so it carries the fork identity instead.)
- The `pgboss_` NOTIFY channel prefix in `plans.ts` — hashed, so a change desyncs LISTEN from NOTIFY during a rolling upgrade.
- The `.pgboss.` advisory-lock seed in `plans.ts` — hashed into the lock id, so a change makes old and new instances stop mutually excluding.
- `timekeeper.ts` `'__pgboss__send-it'` — a persisted queue name and `job.name` value.
- The test/dev database named `pgboss` (`docker-compose.yaml` ↔ `test/config.json` ↔ `.devcontainer/setup-postgres.sh` ↔ `scripts/console.js`) and the `pgboss<sha1>` per-test schemas.

**`tableIsolation` is a separate axis from the SQL dialect.** `'schema'` (default on Postgres/PGlite) puts tables in a dedicated Postgres schema (`pgboss.job`); `'prefix'` folds the schema name into a single quoted identifier in the connection's default schema (`"bunboss.job"`), co-located with the app's tables, and disables partitioning. SQLite has no schemas, so it is **always** prefix. Only object/index qualification differs between modes: `qn`/`qi` in `src/dialect.ts` branch on `tableIsolation`, sharing one `prefixQualify` renderer with the SQLite dialect. Prefix mode's schema-only steps (CREATE SCHEMA, partitioning, the `pg_namespace` case-variant probe) are skipped via `createSchema: false` + `noTablePartitioning: true` (set in `attorney.resolveTableIsolation`) and a contractor guard — no new partition SQL exists.

**SQLite's default namespace changed from `pgboss` to `bunboss`** as part of adding `tableIsolation` — a deliberate fork-level breaking change (SQLite is always prefix, so it now follows `DEFAULT_PREFIX`). Its derived quoted identifiers are `"bunboss.job"` / `"bunboss.version"` by default. Existing SQLite installs pin the old name with `schema: 'pgboss'`.

`test/plansSnapshot.sql` pins the generated **schema-mode** Postgres SQL byte-for-byte (against an explicit `pgboss` schema), so it is the tripwire for the identifiers above: **if a change makes that snapshot diff, a must-not-change identifier was renamed** — fix the cause rather than regenerating with `UPDATE_SNAPSHOTS=true`.

Use "bun-boss"/`BunBoss` for the project, package, and class; "pg-boss" only when naming upstream (`timgit/pg-boss`), and `pgboss` only for the schema-mode identifiers above.

## Direction

- **Bun-first.** Runtime, test suite, CI, and every `package.json` script are Bun. There is no compile step: the package publishes raw `src/*.ts` (`main`/`types` both point at `src/index.ts`, `files` ships `src`), so consumers are Bun too — Node refuses type stripping inside `node_modules`, and would need a bundler. TypeScript stays for type-checking only (`tsc --noEmit`).
- **SQLite is a supported backend** (`backend: 'sqlite'` + `fromBunSqlite` over Bun's `SQL` on a `sqlite://` URL). It is a second SQL *dialect*, not another Postgres-compatible profile: `src/dialect.ts` holds the rendering primitives (`qualify`, state IN-lists, epoch time math, json_each arrays), `plans.ts` builders take a `Ctx` (bare string ⇒ postgres, so static callers are untouched), and the truly divergent shapes (install DDL, insertJobs, updateJob, cacheQueueStats) are explicit sqlite forks beside their postgres twins. `test/plansSnapshot.test.ts` pins postgres output byte-for-byte; `test/dialect.test.ts` guards the silent-correctness traps (enum ordering, timestamp shape, pg-only construct leaks). SQLite installs fresh at the current schema version (v1) — there is no migration history and no in-place upgrade. `scripts/spike-bun-sqlite.ts` documents the Bun sqlite driver behaviors the adapter depends on — its header maps each known bug to the workaround it buys, so read it before changing `src/adapters/sqlite.ts` and run it when moving toolchains.
- **The Bun-adapter traps are documented at their sites, not in one file.** Parameter-encoding fragility and the Bun 1.3.x pooled-connection leak live as WHY comments in `src/adapters/bun.ts` and the queue-cache comments in `src/manager.ts`. Read those before changing `src/adapters/bun.ts`, and keep them current when a Bun release fixes one.

## Commands

Requirements: **Bun 1.3.14 or newer, 1.4+ recommended**, for consumers and for working on this repo alike — the built-in driver is Bun's `SQL` client through `fromBunSql`; on 1.3.x Bun can hand a pooled connection to a waiting query before the ROLLBACK of a failed transaction block lands, surfacing as a spurious `25P02` that the adapter retries away (see the adapter comments in `src/adapters/bun.ts`). The whole test suite and every `package.json` script run under Bun — `test/testHelper.ts` imports Bun's `SQL` at module load, so the suite cannot run under Node — and each script shells out to `bun`/`bunx`. The published library ships uncompiled TypeScript, so it is consumed by Bun directly, and needs **PostgreSQL ≥ 13**. Tests need a running Postgres, supplied **either** by Docker **or** by a local install — try both. `docker compose up -d db` starts a container matching `test/config.json` (db `pgboss`, user/pass `postgres`); where Docker is unavailable, a local Postgres on `127.0.0.1:5432` with the same db/user/pass works identically (check with `pg_isready` / `PGPASSWORD=postgres psql -h localhost -U postgres -d pgboss -c 'select 1'`).

- `bun run test` — the full check: `eslint . && bun test --parallel --timeout 120000`. The `pretest` hook runs `bun run tsc` (`tsc --noEmit`) first, so a failing type-check fails the test command before any test runs. Test-runner behavior (preloads for `test/hooks.ts` and the duplicate-name guard) lives in `bunfig.toml`. `--parallel` spreads test *files* across worker processes (and implies `--isolate`, so each file re-evaluates the module graph and preloads in its own process); tests within a file still run sequentially, which is what keeps the per-file module state in `hooks.ts`/`harness.ts` safe. Never add `--concurrent` (tests within a file overlapping) — it would corrupt that shared state.
- `bun run test -- ./test/send.test.ts` — run a single test file (or directly: `bun test --timeout 120000 ./test/send.test.ts`).
- `bun run test -- -t "substring of test name"` — run tests matching a name.
- `bun run cover` — tests with coverage (text + lcov).
- `bun run tsc` — type-check only (`tsc --noEmit`). `bun run lint:fix` — autofix lint.

### CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR, entirely under Bun (`container: oven/bun:<version>` — no Node toolchain; the toolchain is selected by image because `bun upgrade` needs `unzip`, which these images lack). The matrix runs `standard` against a Postgres service container on both `1` and `canary` — the built-in driver is Bun's own SQL client, so the standard suite is what depends on Bun itself — plus `no-skip-locked-no-cte` on `1`. Separate PGlite and SQLite jobs need no database (the SQLite job also runs on both toolchains and re-verifies the Bun sqlite driver behaviors with `scripts/spike-bun-sqlite.ts` first).

### Running against other backends

The suite is parameterized by `DB_TYPE` / `NO_SKIP_LOCKED_NO_CTE` env vars (resolved in `test/testHelper.ts`):

- `bun run test:no-skip-locked-no-cte` — `NO_SKIP_LOCKED_NO_CTE=true`, exercises the atomic-UPDATE fetch + split-statement write paths on plain Postgres (fast, no separate DB).
- `bun run test:pglite` — `DB_TYPE=pglite`, in-process WASM Postgres, no server. Connection-string / subprocess / multi-connection tests auto-skip; LISTEN/NOTIFY behavior tests run **only** here (PGlite's in-process `listen` is the one listener in the suite).
- `bun run test:sqlite` — `DB_TYPE=sqlite`, in-process SQLite through Bun's `SQL` client (`fromBunSqlite`), no server. This is the one backend that is a *different SQL dialect*, not Postgres-compatible: `src/dialect.ts` supplies rendering primitives to `plans.ts` (a bare-string schema arg means postgres; a `PlanContext` carries the dialect), and `test/plansSnapshot.test.ts` pins the postgres output byte-for-byte. Skips everything pglite skips plus the pg-catalog-shaped tests.

## Architecture

### Component composition

`src/index.ts` defines the public `BunBoss` class (an `EventEmitter`). It does almost no work itself — the constructor builds a set of collaborator objects, all sharing one `IDatabase` and one resolved config, and public methods delegate (mostly to `Manager`). Each collaborator is itself an `EventEmitter`; `#promoteEvents` re-emits their events on the `BunBoss` instance, which is how `error`/`warning`/`wip`/`flow` surface to the user.

- **`manager.ts`** — the core (largest file). All job operations: `send`/`insert`/`fetch`/`work`/`complete`/`fail`/`cancel`/`retry`, queue CRUD, pub/sub, stats. Owns the `Worker` instances created by `work()`.
- **`boss.ts`** — the background **supervisor**. A timer (`superviseIntervalSeconds`) drives `supervise()`, which per queue-table monitors backlog, fails timed-out/heartbeat-stale jobs, deletes jobs past their retention window, and cleans up orphaned job dependencies.
- **`contractor.ts`** — schema **install and verify** on `start()`. Reads the target version from `package.json` → `bunboss.schema` and installs it fresh at that version; an older installed schema throws rather than migrating in place (with `migrate: false` it verifies instead of installing). Also exposes the static `getConstructionPlans` used by `index.ts`.
- **`timekeeper.ts`** — **cron scheduling** (via `croner`); enqueues due scheduled jobs and watches for clock skew.
- **`navigator.ts`** — background **flow / job-dependency resolver**. Off-hot-path: audits completed "blocking" parents and unblocks children (job completion itself stays join-free for speed).
- **`notifier.ts`** — **LISTEN/NOTIFY** listener lifecycle. A NOTIFY is only ever a _latency hint_ that wakes workers to poll sooner; if the listener can't be established, it warns and falls back to polling. Never required for correctness. A listener needs a `db` adapter implementing `listen` (`fromPglite`); the built-in driver has none.
- **`worker.ts`** — the per-`work()` polling loop. Resolves its next delay each iteration (burst / notify-backstop / base poll) and can be woken early by `notify()`.
- **`db.ts`** — the built-in `IDatabase`: Bun's `SQL` client wrapped by `fromBunSql`, so the default driver carries the same adapter workarounds as a user-supplied Bun.SQL handle. Implements `executeSql` and `withTransaction` (via `sql.begin`); no `listen`. `DatabaseOptions` carries Bun's own `SQL` option names, so `#sqlOptions` forwards an allowlist of them verbatim — no renames, no unit conversions, and Bun's defaults apply. The allowlist exists because the resolved config also carries every non-connection option; it deliberately omits `prepare` and `bigint`, which the adapter's parameter encoding depends on. `application_name` is the one setting still reshaped, into Bun's `connection: {}`.

### plans.ts is the single source of truth for SQL

Every SQL string and all DDL lives in **`src/plans.ts`**. Components never inline SQL — they call a `plans.*` builder and pass the result to `db.executeSql`. When changing behavior that touches the database, change it in `plans.ts`.

### Backend compatibility flags

The library targets stock Postgres, embedded PGlite, and embedded SQLite. `attorney.ts` (`resolveBackend`) maps a `backend` profile to a set of internal `noXxx` compatibility flags — e.g. `noSkipLocked`, `noMultiMutationCte`, `noTablePartitioning`, `noAdvisoryLocks`, `noListenNotify`, `noCoveringIndexes`. These flags are **not user-configurable**; they are derived from the profile and thread through `plans.ts`, `manager.ts`, and `boss.ts` to select alternate query strategies (e.g. the split select/delete/re-insert path when `noMultiMutationCte`, atomic-UPDATE fetch when `noSkipLocked`). When touching a query, check whether it has a no-flag variant.

`sqlite` is the profile that turns every flag on (plus its own dialect rendering), so it exercises the flagged branches end-to-end. The postgres-dialect branches of these flags are covered on plain Postgres by the `__test__noSkipLockedNoCte` hook (`NO_SKIP_LOCKED_NO_CTE=true` / `bun run test:no-skip-locked-no-cte`, forcing `noSkipLocked` + `noMultiMutationCte`) and the other `__test__` construction hooks, since the flags are not publicly configurable.

### Config resolution

`attorney.ts` is the validation/normalization layer. `getConfig` resolves constructor options (and the backend); the `check*` functions validate `send`/`work`/`schedule`/queue options before they reach `manager.ts`. User input is validated here, not deeper in.

### Bring-your-own database & adapters

Anything implementing `IDatabase` (`executeSql`, optionally `withTransaction`/`listen`) can back the library instead of the built-in pool — this is how jobs are created inside an existing app transaction. `src/adapters/` wraps a driver's connection or transaction object (`fromPglite`, `fromBunSql`); both use native `$N` placeholders.

`fromBunSql` is also what the built-in driver (`src/db.ts`) wraps its own `SQL` client with, and it carries workarounds for Bun behaviors that differ from node-postgres: the SQLSTATE arrives on `err.errno` rather than `err.code` (which `manager.ts` keys real behavior on), JSON parameters are re-encoded from the library's already-serialized payloads, JS arrays are not bound as postgres arrays, and `BEGIN … COMMIT` blocks are refused on a pooled connection so they run on a reserved one. Because the default run routes every query through this adapter, it is what catches a new `plans.ts` query whose json parameter the adapter's cast classifier does not recognize — the classifier keys solely on an explicit `::json`/`::jsonb` cast, so every json placeholder in `plans.ts` must carry one (a `plansSnapshot.test.ts` guard enforces this at the SQL source).

## Testing conventions

- Test files are `test/**/*.test.ts`, run by `bun test`; compile-only type tests are `test/**/*TypeTest.ts` — deliberately outside the runner's discovery patterns, enforced solely by `tsc --noEmit` (the `pretest` hook).
- **Every test must import `it`/`describe`/`expect` from `test/harness.ts`, never use the runner's injected globals** (an eslint `no-restricted-globals` rule enforces this). The harness `it` wraps the test body with per-test schema setup because bun's hooks receive no test context; a raw `it` would silently run against the previous test's schema.
- **Each test derives its own Postgres schema from `sha1(testFile + testName)`** (see `test/hooks.ts`), and that schema doubles as the queue namespace. So **leaf test names must be unique within a file** — a preload (`checkDuplicateTestNames.ts`, wired in `bunfig.toml`) statically rejects duplicates, because a collision manifests as flaky cross-test interference (especially under the single shared PGlite instance), not a clean failure. A failed test's schema is kept for debugging; it is dropped on the next run of that test.
- Use the skip helpers from `testHelper.ts` rather than raw `it` when a test depends on backend specifics: `itPostgresOnly`/`describePostgresOnly` (partitioning, covering indexes, exact PG schema shape), `itPglite`/`describePglite` (needs a real server or multiple connections).

## Docs

`docs/` is plain markdown (the vitepress tooling was removed in the fork). Prose and code samples name `bun-boss`/`BunBoss`; the only surviving `pgboss` mentions are schema names and DDL, and the only `pgboss.io` link is the upstream-docs pointer in `README.md`. Samples use the named import (`import { BunBoss } from 'bun-boss'`) because there is no default export. `docs/database-backends.md` is the one that tracks fork behavior: it documents the Bun version floor, the `prepare: true` requirement, and the LISTEN/NOTIFY gap, so update it alongside `src/adapters/bun.ts`.

## Comments in code

Code comments should be rare. Only when it's important to explain WHY an implementation looks the way it does, never WHAT the code does (that can be easily deduced from the code itself!). A comment should be ONE single sentence. Only in extremely rare occurences where it's important to expand on the WHY rationale, may you add a SECOND sentence.

## Commit messages

Titles follow the Conventional Commits format release-please parses: `type(optional-scope): description`. Types are `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore` — only `feat` and `fix` produce a release entry. Mark a breaking change with `!` before the colon (`feat(api)!: …`) or a `BREAKING CHANGE:` footer.

Keep the description SHORT and concise: one imperative line, lowercase, no trailing period, under ~72 characters. Add a body only when the *why* is not obvious from the diff, and keep it to a couple of lines.

```
fix(adapters): reserve a connection for transaction blocks
feat(sqlite): add fromBunSqlite backend
chore: drop cross-env dependency
```

## GitHub

**This is a fork, and `gh` will target the wrong repository by default.** `origin` is
`khromov/bun-boss`; `upstream` is `timgit/pg-boss`, which we do not own. `gh` resolves a fork's
default base to its *parent*, so a bare `gh pr create` opens a pull request **against
`timgit/pg-boss`** — a public, unwanted PR on a stranger's repository.

Never rely on the default. Pass `--repo khromov/bun-boss` to every `gh` command that touches a
repository (`pr create`, `pr list`, `pr view`, `issue create`, `api`, …), and for a new PR name the
head branch explicitly too:

```
gh pr create --repo khromov/bun-boss --base main --head khromov:<branch> [--draft]
```

Then confirm it landed where you meant, before saying it is done:

```
gh pr view <n> --repo khromov/bun-boss --json url,baseRefName,isDraft
```

A checkout should also have its default pinned once, which makes bare commands safe:
`gh repo set-default khromov/bun-boss`. This writes to `.git/config`, so it is per-clone and is not
inherited by a fresh clone — check it with `gh repo set-default --view` rather than assuming.

If a PR does open upstream by mistake, close it immediately with a brief explanatory comment, then
reopen it on the fork.

When reviewing a PR, use the https://github.com/khromov/bun-boss repo to check issue numbers.
