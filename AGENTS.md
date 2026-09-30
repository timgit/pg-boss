# Working on pg-boss

Rules for anyone changing this repo, human or agent. `CLAUDE.md` imports this file.

## Setup and tests

```bash
npm install
docker compose up -d        # Postgres on 127.0.0.1:5432, credentials in test/config.json
npm test                    # lint, typecheck, schema manifest check, then the full suite
npx vitest run test/fooTest.ts
```

Other backends run the same suite: `npm run test:pglite`, `npm run test:cockroachdb:full`, `npm run test:yugabytedb:full` and `npm run test:citus:full`, each against its own `docker-compose.*.yaml`.

Two ways the suite fails that are not regressions:

- Under `--coverage`, timing-sensitive tests fail, and a different set on each run. Re-run the failed files without `--coverage` before treating one as broken.
- `DB_TYPE=pglite` with file parallelism fails a rotating set with hook timeouts. Re-run with `--no-file-parallelism` before believing a red run.

## Layout

- `src/plans.ts` builds every SQL statement for the current schema.
- `src/migrationStore.ts` holds one entry per schema version, with `install` and `uninstall`.
- `src/types.ts` is the public API surface. `docs/` is the VitePress site at pgboss.io.
- `packages/dashboard` and `packages/proxy` are separate npm packages.

## Schema changes

A schema change bumps `pgboss.schema` in `package.json`, adds a `migrationStore.ts` entry for that version, updates the builders in `plans.ts` so a fresh install matches, and regenerates the manifest with `npm run gen:manifest` (`npm test` checks it).

**A migration never reads DDL from `plans`.** Copy the SQL into the migration as it stands for that version: a `CREATE TABLE`, an index, a function body, an enum's values or a CHECK expression. A `plans` builder tracks the current schema and drifts as later versions change it, so a migration that calls one stops emitting its own version's DDL. The only `plans` calls allowed in `migrationStore.ts` are the runner helpers that wrap every migration: `assertMigration`, `setVersion` and `locked`. Before finishing a change there, check:

```bash
grep -n "plans\." src/migrationStore.ts
```

Only comments and those three helpers should match. When an older migration needs a snapshot of DDL that later changes, add it to a version-keyed map in `migrationStore.ts` (like `createQueueFn`), and leave the older entries untouched.

Migration comments cover the migration only: table rewrites, backfill, existing rows, build order, backend quirks. What a column or index means belongs above its builder in `plans.ts`.

Do not write a test per migration. `test/migrationTest.ts` rolls back the newest few versions (`MIGRATION_DEPTH`), replays them and compares the result with a fresh install, so a new migration is covered the moment it lands.

## SQL

- Timestamps come from `${schema}.job_now()`, never `now()` or `clock_timestamp()`, so a test clock can redirect them. ESLint enforces this. Column defaults are the exception, and a `CREATE TABLE` with `DEFAULT now()` (in `plans.ts`, or copied into a migration) sits inside a scoped `/* eslint-disable no-restricted-syntax -- ... */` and `/* eslint-enable no-restricted-syntax */` pair that says why.
- No `--` comments inside SQL template strings. If the note is needed, it becomes a `//` comment above the function that builds the SQL.

## Comments and docs

- Doc comments on public types, options and methods are one or two sentences: what it does, its constraints, its default, and `@see https://pgboss.io/api/<page>#<anchor>` when there is more. Rationale, costs, benchmarks and design history go in `docs/api/*.md`, stated neutrally.
- VitePress slugs headings its own way: `fetch(name, options)` becomes `#fetch-name-options`. `npm run docs:anchors` checks every anchor link in `docs/` and every `pgboss.io` link in `src/`, and CI runs it. Add `-- --fix` to rewrite a broken anchor that has a single matching heading.
- Write separate sentences instead of em or en dashes.

## Commits

One line, with the conventional-commit prefix the history uses (`feat:`, `fix(schedule):`, `docs:`, `test:`, `ci:`). No body and no trailers. If it does not fit on one line, split the commit.

Never put a closing keyword (`fixes #N`, `closes #N`, `resolves #N`) in a commit message: GitHub closes the issue as soon as the commit reaches the default branch. `refs #N` is fine. `closes #N` belongs in the PR description.
