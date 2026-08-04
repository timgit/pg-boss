# Feasibility: adding SQLite as a pg-boss backend

## Verdict

Feasible in principle, but it is **not "add another backend profile" — it is a second SQL dialect port**.
Every existing backend (CockroachDB, YugabyteDB, Citus, PGlite) is a *Postgres-compatible engine*: the
`attorney.ts` compatibility flags (`noSkipLocked`, `noAdvisoryLocks`, `noListenNotify`, …) toggle
*features* on top of one shared Postgres dialect. SQLite breaks that shared-dialect assumption, so the
cost lands in every layer that assumes Postgres SQL. Rough scale: a multi-week fork-level effort with a
permanent 2× maintenance tax on all future SQL changes. If the goal is merely "embedded / no server",
the existing **`pglite` profile already delivers that with zero compatibility flags** — SQLite is only
worth it if the driving requirement is transactional enqueue into an *existing SQLite app database*.

## What already helps

- **The concurrency story maps cleanly.** The `noSkipLocked` fetch path (`plans.ts:1357`) claims jobs
  via an atomic `UPDATE … RETURNING` with no row locks — exactly what a single-writer engine wants,
  and SQLite has supported `RETURNING` since 3.35. Likewise `noAdvisoryLocks`, `noListenNotify`
  (poll-only), `noTablePartitioning`, and `noMultiMutationCte` (split select/mutate paths) all describe
  SQLite accurately. The *feature* flags are ~right; only the dialect is wrong.
- **`IDatabase` is tiny** (`executeSql`, optional `withTransaction`/`listen`), and
  `adapters/placeholders.ts` already parses `$N` into positional segments — the `?`-style binding
  better-sqlite3 wants. A driver adapter is a day of work.
- **Modern SQLite is closer than its reputation:** upsert `ON CONFLICT` (3.24+), CTEs, JSON `->`/`->>`
  operators (3.38+), `RETURNING`, strict tables.

## What's hard

`src/plans.ts` is ~3,000 lines and the single source of truth for all SQL; ~150 lines use constructs
SQLite lacks outright:

| Postgres construct (count in plans.ts) | SQLite reality |
| --- | --- |
| Dedicated schema per instance (`CREATE SCHEMA`, all names schema-qualified) | No schemas — `ATTACH` databases or table-name prefixes; invasive rewrite |
| `jsonb` type, `jsonb_exists`, `jsonb_object_agg` (~35 uses) | JSON1 functions differ; type is just TEXT/BLOB |
| `timestamptz`, `now() + $1::interval` arithmetic (~77 `now()` uses) | Text/integer time, `datetime('now', '+N seconds')` rewrites everywhere |
| Arrays: `::text[]`, `unnest`, `array_agg`, `ANY($1)` (~40 uses) | No arrays — JSON arrays + `json_each` rewrites |
| `uuid` type/generation (~33 uses) | Generate in JS, store TEXT |
| `CREATE TYPE` (enum), `CREATE FUNCTION` (6) | CHECK constraints; app-defined functions are driver-specific |
| `CREATE INDEX CONCURRENTLY` + `pg_stat_progress_create_index` | Doesn't exist — the entire **BAM** async-migration component loses its purpose |
| `pg_catalog` introspection (`drifter.ts`, `scripts/gen-manifest.ts`, `schema.json`) | Full re-implementation on `pragma_*` tables, plus a second manifest shape |
| `migrationStore.ts` (1,288 lines of versioned Postgres DDL deltas) | SQLite needs its own parallel migration history from v-first |
| `LISTEN/NOTIFY` latency hints | None; in-process update hooks at best (already optional, so acceptable loss) |

Beyond SQL: SQLite is single-writer (fine for a job queue at modest scale, and WAL mode gives
concurrent readers), but multi-process pollers contend on the write lock and need busy-timeout tuning;
multi-node is off the table entirely. Tests (`test/testHelper.ts`, per-test schema derivation in
`test/hooks.ts`) assume Postgres schemas as namespaces and would need a SQLite-specific strategy.

## If pursued anyway — the shape of the work

1. Introduce a **dialect seam** in `plans.ts` (builders parameterized by dialect, not string forks).
2. Port DDL: prefix-based namespacing, TEXT timestamps/uuids, CHECK-based states; new manifest +
   `drifter` introspection via pragmas.
3. Claim path = the existing atomic `UPDATE … RETURNING` strategy; drop partitioning, BAM, and
   listen/notify via the existing flags plus a new `kind: 'embedded-sqlite'`-style profile.
4. New `DB_TYPE=sqlite` test-matrix entry with auto-skips mirroring the PGlite ones.

## Recommendation

Don't, unless transactional enqueue into an existing SQLite app is the hard requirement. For the
embedded use case, point users at the first-class `pglite` backend (real Postgres, zero flags, already
in the test matrix). If SQLite demand is real, a small purpose-built SQLite queue sharing pg-boss's
API surface would likely cost less than bending pg-boss's Postgres-native core around the dialect gap.
