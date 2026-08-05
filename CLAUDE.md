# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is **bun-boss** (`origin` = `khromov/bun-boss`), an experimental Bun-first fork of pg-boss. `upstream` is `timgit/pg-boss`, which is where the core still comes from — keep diffs against it small and mergeable unless a change is specifically part of the fork's direction.

The library itself is a job queue built on PostgreSQL: it relies on `SKIP LOCKED` for exactly-once delivery and stores all state (jobs, queues, schedules, archive) in a dedicated Postgres schema. The package in `src/` is the whole product.

## Naming: the rename has not happened

Only the repo, the devcontainer, and the docs framing say "bun-boss". The npm package name is still `pg-boss`, the exported class is still `PgBoss`, the schema/queue namespace is still `pgboss`, and internal SQL identifiers are unchanged. **Do not rename any of these opportunistically** — the schema name in particular is on-disk state for every existing install. Use "bun-boss" for the project/repo, "pg-boss" when naming the package, class, or schema.

## Direction

- **Bun-first.** Runtime, test suite, CI, and every `package.json` script are Bun. Node is only a compatibility target for consumers of the published library.
- **SQLite is a supported backend** (`backend: 'sqlite'` + `fromBunSqlite` over Bun's `SQL` on a `sqlite://` URL). It is a second SQL *dialect*, not another Postgres-compatible profile: `src/dialect.ts` holds the rendering primitives (`qualify`, state IN-lists, epoch time math, json_each arrays), `plans.ts` builders take a `Ctx` (bare string ⇒ postgres, so static callers are untouched), and the truly divergent shapes (install DDL, insertJobs, updateJob, cacheQueueStats) are explicit sqlite forks beside their postgres twins. `test/plansSnapshotTest.ts` pins postgres output byte-for-byte; `test/dialectTest.ts` guards the silent-correctness traps (enum ordering, timestamp shape, pg-only construct leaks). SQLite installs fresh at the current schema version (v1) — there is no migration history and no in-place upgrade. `scripts/spike-bun-sqlite.ts` documents the Bun sqlite driver behaviors the adapter depends on (run it when moving toolchains).
- **`ISSUES.txt` is the running log of Bun-adapter traps** (parameter-encoding fragility, the Bun 1.3.x pooled-connection leak). Read it before changing `src/adapters/bun.ts`, and keep it current when one is fixed.

## Commands

Requirements: **Bun 1.4 or newer** — on 1.3.x, Bun can hand a pooled connection to a waiting query before the ROLLBACK of a failed transaction block lands, surfacing as a spurious `25P02` (see `ISSUES.txt` #3). The whole test suite and every `package.json` script run under Bun — `test/testHelper.ts` imports Bun's `SQL` at module load, so the suite cannot run under Node — and each script shells out to `bun`/`bunx`. The published library still targets **Node ≥ 22.12** (for `require(esm)`) and **PostgreSQL ≥ 13**. Tests need a running Postgres — `docker compose up -d db` starts one matching `test/config.json` (db `pgboss`, user/pass `postgres`).

- `bun run test` — the full check: `eslint . && bun --bun vitest run`. The `pretest` hook runs `bun run tsc` (`tsc --noEmit`) first, so a failing type-check fails the test command before any test runs.
- `bun run test -- test/sendTest.ts` — run a single test file.
- `bun run test -- -t "substring of test name"` — run tests matching a name.
- `bun run cover` — tests with V8 coverage.
- `bun run tsc` — type-check only (`tsc --noEmit`). `bun run lint:fix` — autofix lint.
- `bun run build` — clean `dist/` and compile via `tsconfig.build.json`.

### CI

`.github/workflows/ci.yml` runs on every push to `master` and every PR, entirely under Bun (`container: oven/bun:<version>` — no Node toolchain; the toolchain is selected by image because `bun upgrade` needs `unzip`, which these images lack). The matrix is `standard` / `no-skip-locked-no-cte` against a Postgres service container, plus `bun-driver` twice — on `1` and on `canary`, because `fromBunSql` is the one part of the suite whose behavior depends on Bun itself. Separate PGlite and SQLite jobs need no database (the SQLite job also runs on both toolchains and re-verifies the Bun sqlite driver behaviors with `scripts/spike-bun-sqlite.ts` first).

### Running against other backends

The suite is parameterized by `DB_TYPE` / `NO_SKIP_LOCKED_NO_CTE` env vars (resolved in `test/testHelper.ts`):

- `bun run test:no-skip-locked-no-cte` — `NO_SKIP_LOCKED_NO_CTE=true`, exercises the atomic-UPDATE fetch + split-statement write paths on plain Postgres (fast, no separate DB).
- `bun run test:bun` — `DB_TYPE=bun`, routes the whole suite through the `fromBunSql` adapter (Bun's built-in `SQL` client) against the same Postgres server, so the adapter's parameter-binding workarounds are exercised by every query rather than only the dedicated adapter tests.
- `bun run test:pglite` — `DB_TYPE=pglite`, in-process WASM Postgres, no server. Connection-string / subprocess / multi-connection tests auto-skip.
- `bun run test:sqlite` — `DB_TYPE=sqlite`, in-process SQLite through Bun's `SQL` client (`fromBunSqlite`), no server. This is the one backend that is a *different SQL dialect*, not Postgres-compatible: `src/dialect.ts` supplies rendering primitives to `plans.ts` (a bare-string schema arg means postgres; a `PlanContext` carries the dialect), and `test/plansSnapshotTest.ts` pins the postgres output byte-for-byte. Skips everything pglite skips plus the pg-catalog-shaped tests.

## Architecture

### Component composition

`src/index.ts` defines the public `PgBoss` class (an `EventEmitter`). It does almost no work itself — the constructor builds a set of collaborator objects, all sharing one `IDatabase` and one resolved config, and public methods delegate (mostly to `Manager`). Each collaborator is itself an `EventEmitter`; `#promoteEvents` re-emits their events on the `PgBoss` instance, which is how `error`/`warning`/`wip`/`flow` surface to the user.

- **`manager.ts`** — the core (largest file). All job operations: `send`/`insert`/`fetch`/`work`/`complete`/`fail`/`cancel`/`retry`, queue CRUD, pub/sub, stats. Owns the `Worker` instances created by `work()`.
- **`boss.ts`** — the background **supervisor**. A timer (`superviseIntervalSeconds`) drives `supervise()`, which per queue-table monitors backlog, fails timed-out/heartbeat-stale jobs, maintains partitions, and prunes archived jobs.
- **`contractor.ts`** — schema **install and verify** on `start()`. Reads the target version from `package.json` → `pgboss.schema` and installs it fresh at that version; an older installed schema throws rather than migrating in place (with `migrate: false` it verifies instead of installing). Also exposes the static `getConstructionPlans` used by `index.ts`.
- **`timekeeper.ts`** — **cron scheduling** (via `cron-parser`); enqueues due scheduled jobs and watches for clock skew.
- **`navigator.ts`** — background **flow / job-dependency resolver**. Off-hot-path: audits completed "blocking" parents and unblocks children (job completion itself stays join-free for speed).
- **`notifier.ts`** — **LISTEN/NOTIFY** listener lifecycle. A NOTIFY is only ever a _latency hint_ that wakes workers to poll sooner; if the listener can't be established, it warns and falls back to polling. Never required for correctness.
- **`worker.ts`** — the per-`work()` polling loop. Resolves its next delay each iteration (burst / notify-backstop / base poll) and can be woken early by `notify()`.
- **`db.ts`** — the default `IDatabase` backed by a `pg.Pool`. Implements `executeSql`, `withTransaction`, and a self-healing session-pinned `listen()` (dedicated `pg.Client`, TCP keepalive + same-session heartbeat, capped-backoff reconnect).

### plans.ts is the single source of truth for SQL

Every SQL string and all DDL lives in **`src/plans.ts`**. Components never inline SQL — they call a `plans.*` builder and pass the result to `db.executeSql`. When changing behavior that touches the database, change it in `plans.ts`.

### Backend compatibility flags

The library targets stock Postgres, embedded PGlite, and embedded SQLite. `attorney.ts` (`resolveBackend`) maps a `backend` profile to a set of internal `noXxx` compatibility flags — e.g. `noSkipLocked`, `noMultiMutationCte`, `noTablePartitioning`, `noAdvisoryLocks`, `noListenNotify`, `noCoveringIndexes`. These flags are **not user-configurable**; they are derived from the profile and thread through `plans.ts`, `manager.ts`, and `boss.ts` to select alternate query strategies (e.g. the split select/delete/re-insert path when `noMultiMutationCte`, atomic-UPDATE fetch when `noSkipLocked`). When touching a query, check whether it has a no-flag variant.

`sqlite` is the profile that turns every flag on (plus its own dialect rendering), so it exercises the flagged branches end-to-end. The postgres-dialect branches of these flags are covered on plain Postgres by the `__test__noSkipLockedNoCte` hook (`NO_SKIP_LOCKED_NO_CTE=true` / `bun run test:no-skip-locked-no-cte`, forcing `noSkipLocked` + `noMultiMutationCte`) and the other `__test__` construction hooks, since the flags are not publicly configurable.

### Config resolution

`attorney.ts` is the validation/normalization layer. `getConfig` resolves constructor options (and the backend); the `check*` functions validate `send`/`work`/`schedule`/queue options before they reach `manager.ts`. User input is validated here, not deeper in.

### Bring-your-own database & adapters

Anything implementing `IDatabase` (`executeSql`, optionally `withTransaction`/`listen`) can back the library instead of the built-in pool — this is how jobs are created inside an existing app transaction. `src/adapters/` wraps a driver's connection or transaction object (`fromPglite`, `fromBunSql`); both use native `$N` placeholders.

`fromBunSql` is the one adapter that also replaces the pool outright, and it carries workarounds for Bun behaviors that differ from node-postgres: the SQLSTATE arrives on `err.errno` rather than `err.code` (which `manager.ts` keys real behavior on), JSON parameters are re-encoded from the library's already-serialized payloads, JS arrays are not bound as postgres arrays, and `BEGIN … COMMIT` blocks are refused on a pooled connection so they run on a reserved one. `DB_TYPE=bun` (`bun run test:bun`) runs the whole suite through it, and that job is the only thing that catches a new `plans.ts` query whose json parameter the adapter's cast classifier does not recognize — `ISSUES.txt` #2 explains why that classifier is a second source of truth about `plans.ts`.

## Testing conventions

- Test files are `test/**/*Test.ts`; compile-only type tests are `test/**/*TypeTest.ts` (run by vitest's `typecheck`).
- **Each test derives its own Postgres schema from `sha1(testFile + testName)`** (see `test/hooks.ts`), and that schema doubles as the queue namespace. So **leaf test names must be unique within a file** — a `globalSetup` (`checkDuplicateTestNames.ts`) statically rejects duplicates, because a collision manifests as flaky cross-test interference (especially under the single shared PGlite instance), not a clean failure.
- Use the skip helpers from `testHelper.ts` rather than raw `it` when a test depends on backend specifics: `itPostgresOnly`/`describePostgresOnly` (partitioning, covering indexes, exact PG schema shape), `itPglite`/`describePglite` (needs a real server or multiple connections).

## Docs

`docs/` is plain markdown (the vitepress tooling was removed in the fork) and is still written from upstream's Node/pg-boss point of view, with links to `pgboss.io`. `docs/database-backends.md` is the one that tracks fork behavior: it documents the Bun 1.4 floor, the `prepare: true` requirement, and the LISTEN/NOTIFY gap, so update it alongside `src/adapters/bun.ts`.

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
gh pr create --repo khromov/bun-boss --base master --head khromov:<branch> [--draft]
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
