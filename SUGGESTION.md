# Slimming bun-boss: what to cut and what to keep

## Verdict

The core queue — `send` / `fetch` / `work` / `complete` / `fail`, retries, dead letter, policies,
partitioning — is lean and earns its keep. Nearly all the fat is **operational machinery layered around
it**: schema drift detection, a twelve-version migration store, an async DDL worker, a CLI, and three
distributed-Postgres backends that CI never starts.

**Tier 1 removes ≈4,000 lines of `src/` (about a third) and ≈4,400 lines of tests, plus a 2,069-line
generated artifact and two build-time couplings — with zero change to job semantics.** No public method
on the hot path is touched. Tier 2 adds ≈370 more src lines and ≈1,170 test lines, but breaks API.

Two decisions frame everything below and are assumed throughout:

1. **The SQLite / in-memory roadmap is live.** So the `noXxx` compatibility-flag *seam* stays; only the
   three distributed-Postgres *profiles* go. These are separable — see cut #1.
2. **Fresh install only.** No in-place upgrade from an existing pg-boss database, which is what unlocks
   the two largest cuts.

## Method: two axes, not one

LOC alone ranks these wrong. `CLAUDE.md` requires keeping diffs against `upstream` small and mergeable,
which makes *where* code lives matter as much as how much of it there is:

- **Cheap forever** — deleting a whole file (`drifter.ts`, `cli.ts`, `migrationStore.ts`, `bam.ts`,
  `spy.ts`) plus its import sites. Upstream edits to a file we deleted surface as a trivial
  delete/modify conflict, resolved once with `git rm`.
- **Expensive forever** — surgery *inside* `plans.ts`, `manager.ts`, or `attorney.ts`, which upstream
  edits constantly. Every such cut is a permanent conflict magnet on the exact lines most likely to move.

This is why the ordering below is file-deletions-first, and why one Tier 2 recommendation
(cut `localGroupConcurrency`, not group `tiers`) deliberately inverts the naive LOC ranking.

### Baseline

| | |
|---|---|
| `src/` TypeScript | 12,284 LOC across 22 files |
| `src/schema.json` | 2,069 lines (generated) |
| `test/` | 17,412 LOC across 70 files |
| `docs/` | 3,327 lines |
| Runtime deps | 3 — `pg`, `cron-parser`, `serialize-error` |

`plans.ts` (3,029) + `migrationStore.ts` (1,288) + `schema.json` (2,069) = **44% of `src/` is SQL and DDL
artifacts.** That is where the slimming has to happen.

## Scorecard

| Feature | src | test | Merge cost | Verdict |
|---|---|---|---|---|
| Migrations + rollback | ~1,380 | 922 | file delete | **Cut** |
| Schema drift detection | ~870 | 1,055 | mostly file delete | **Cut** |
| CLI | 603 | 671 | file delete | **Cut** |
| BAM async migrations | ~450 | 482 | file delete | **Cut** (after migrations) |
| Queue-stats history + warning persistence | ~310 | ~640 | in-place, isolated | **Cut** |
| CockroachDB / YugabyteDB / Citus profiles | ~200 | ~150 | in-place, small | **Cut** — keep the seam |
| Job spies | ~200 | 499 | file delete | **Cut** |
| `localGroupConcurrency` | ~200 | 571 | in-place, pure JS | Cut (Tier 2) |
| Pub/sub | ~75 | 131 | in-place, isolated | Cut (Tier 2) |
| `exclusive` + `key_strict_fifo` policies | ~60 | ~400 | in-place, isolated | Cut (Tier 2) |
| `JobMatchStrategy` | ~25 | ~70 | in-place, 4 lines | Cut (Tier 2) |
| `getJobById` | ~10 | — | trivial | Cut (Tier 2) |
| Compatibility-flag seam | ~500 | — | — | **Keep** (decision 1) |
| Flows + navigator | ~700 | 764 | — | **Keep** |
| Cron / timekeeper | ~320 | 492 | — | **Keep** |
| Group concurrency (base + tiers) | ~410 | ~930 | high | **Keep** |
| LISTEN/NOTIFY | ~330 | 749 | — | **Keep** |
| Partitioning | ~475 | — | — | **Keep** |

---

# Tier 1 — operational fat

No change to job semantics. Every cut here is invisible to code that calls `send`/`work`.

## 1. Drop the CockroachDB, YugabyteDB, and Citus profiles — keep the flag seam

**≈200 src · ≈150 test · 3 compose files · 4 scripts · 3 configs · ~150 doc lines**

The strongest single argument: **CI never tests them.** `.github/workflows/ci.yml` runs
`standard`, `distributed`, `bun-driver` on two toolchains, and `pglite`. There is no CockroachDB,
YugabyteDB, or Citus job. Three backends we advertise are unverified on every commit and only runnable
by hand.

The seam survives the profiles because the mapping is a plain data lookup — `resolveBackend`
(`attorney.ts:482-513`):

```js
for (const flag of COMPATIBILITY_FLAGS) {
  config[flag] = flags[flag] ?? false
}
```

Every downstream consumer in `plans.ts`, `manager.ts`, `boss.ts`, `bam.ts`, `notifier.ts`, `navigator.ts`
reads `config.noXxx` and **never reads `config.backend`** for flag purposes. Delete the three
`BACKEND_PROFILES` entries and the mechanism is untouched. Two bonus findings:

- **`citus` sets zero flags** (`attorney.ts:70`) — behaviorally byte-identical to `postgres`. It is a
  test-matrix label and nothing else.
- **`BackendDefinition.kind`** (`attorney.ts:33`) is never read anywhere in the repo. Dead field.

Also deletable, because it is backend-specific and *not* flag-mediated: the six
`backend === 'cockroachdb'` `Number()` coercion sites in `manager.ts`, `canonicalPg` in
`contractor.ts:192`, and the YugabyteDB version sniff at `index.ts:184-200`.

**Note:** `noCoveringIndexes` is already half-dead. `plans.ts:723-731` records that the `job_i5` INCLUDE
was removed as measured dead weight and that "noCoveringIndex … is now moot here"; the parameter is
accepted and ignored. It survives for exactly one index, `createIndexQueueStats` — which cut #6 deletes.

### The one real cost

After this cut, four flags have **no producer at all** — no profile and no test hook:
`noTablePartitioning`, `noDeferrableConstraints`, `noCoveringIndexes`, `noListenNotify`. Those branches
will silently rot before the SQLite work reaches them.

`__test__distributed` already covers `noSkipLocked` + `noMultiMutationCte`, and `__test__noAdvisoryLocks`
/ `__test__noIndexProgressView` cover two more. **Add matching hooks for the remaining four in the same
change**, or the seam we are preserving stops being trustworthy.

**Delete:** `docker-compose.{cockroach,yugabyte,citus}.yaml` · `test/config.{cockroachdb,yugabytedb,citus}.json` ·
the four `test:cockroachdb*` / `test:yugabytedb:full` / `test:citus:full` scripts ·
`docs/database-backends.md:154-292` · ~60 lines of `test/testHelper.ts`.
**Keep:** `test/distributedDatabaseTest.ts` (406) and `test/advisoryLockFreeTest.ts` (64) — both run on
plain Postgres via the test hooks, and they *are* the seam's test coverage.

## 2. Drop schema drift detection

**≈870 src · 1,055 test · a 2,069-line generated artifact · one build gate**

`drifter.ts` (503) introspects `pg_catalog` for indexes, functions, the `job_state` enum, tables, columns,
and constraints, then diffs against a generated manifest. Around it: `contractor.detectDrift` (~100),
`expectedManaged*` in `plans.ts:2882-3029` (~148), `scripts/gen-manifest.ts` (116), and
`test/driftTest.ts` — at 1,055 lines the largest test file in the repo, a **2.1:1 test-to-source ratio**,
the highest anywhere here.

It is cleanly separable. `schema.json` has **exactly one importer** (`plans.ts:10`), and nothing outside
drift consumes the `expectedManaged*` functions.

The real cost is not the LOC, it is the permanent friction: `pretest` runs `gen:manifest:check`, so
**every DDL change in `plans.ts` fails CI until the manifest is regenerated**, forever. That toll is paid
on every schema edit to detect a failure mode — someone hand-altered pg-boss's indexes — that almost
nobody hits.

**Removes:** `boss.detectSchemaDrift()`, `SchemaDriftReport` and its 8 component types
(`index.ts:527-580`), the CLI `doctor` command, the `gen:manifest` / `gen:manifest:check` scripts.
`package.json`'s `pretest` hook must be edited in the same commit or `bun run test` breaks on a missing
script.

**One correction worth recording:** `@electric-sql/pglite` is *not* a gen-manifest-only devDependency.
`test/testHelper.ts:3` imports it at module top level and `test/pgliteTest.ts` uses a real instance. It
stays regardless.

## 3. Collapse migrations to a v37 baseline

**≈1,380 src · 922 test**

`migrationStore.ts` is 1,288 lines carrying twelve migrations, v26 → v37, each with `install` *and*
`uninstall` arrays. Only ~430 of those lines are actual deltas. **The other ~700 are frozen historical
DDL** — seven complete copies of the `create_queue()` plpgsql body (~586 lines), one per schema version,
plus versioned snapshots of the `queue_stats` DDL, kept so old migrations don't drift when `plans.ts`
changes. Every future DDL change adds another snapshot.

Under decision 2 this becomes: `plans.create()` at v37, plus a version check that throws on mismatch.
`contractor.ts` collapses from 249 lines to roughly 60. `getMigrationPlans` / `getRollbackPlans` and the
`migrate` option disappear.

**What you give up:** an existing pg-boss user cannot point bun-boss at their database. Given the fork is
pre-1.0 and explicitly "not yet production-ready", that is a cheap trade for the largest single
simplification available.

## 4. Drop BAM — dead code once #3 lands

**≈450 src · 482 test**

BAM ("build a migration") runs queued `CREATE INDEX CONCURRENTLY` off the startup path. **Its producer is
migration-only**, verified exhaustively:

- The only inserts into `bam` are the two inside the `job_table_run_async()` plpgsql body
  (`plans.ts:340`, `:352`).
- The only callers of that function are five migration blocks — `migrationStore.ts:989`, `:1025`,
  `:1159`, `:1170`, `:1177`.
- **`create_queue()` never enqueues BAM.** It builds partition indexes *synchronously* via
  `job_table_format` (`plans.ts:594-612`). Fresh install creates the `bam` table and inserts zero rows.

So once migrations are gone, `bam.ts` (175), its ~250 lines of SQL in `plans.ts`, the `bam` table,
`getBamStatus`/`getBamEntries`/`isBamWorking`, the `bam` event, and `bamIntervalSeconds` are all
unreachable.

**Ordering matters:** do #2 before #3/#4. `'bam'` is in `FIXED_MANAGED_TABLES` (`plans.ts:2908`) and
`getIncompleteBamCommands` is read by `detectDrift` (`contractor.ts:127`). Cut drift first and dropping
the table is unencumbered.

## 5. Drop the CLI

**603 src · 671 test**

`migrate`, `create`, `version`, `doctor`, `rollback`, `plans <…>`. After #2 and #3, `doctor`, `migrate`,
`rollback`, and the migration `plans` subcommands have nothing left to call — the CLI collapses to
`create` and `version`, which are two lines of script. Drops the `bin` entry and the `cli-testlab`
devDependency. (`cmdDoctor`'s ~130 lines are counted under #2, not here.)

Everything remaining is reachable programmatically via the static `Contractor` helpers.

## 6. Drop persisted queue-stats history and warning persistence

**≈310 src · ≈640 test**

Two clearly separable halves, and only one is load-bearing:

- **Keep** the live cached counts on the `queue` table. They feed fetch decisions and the
  `warningQueueSize` backlog warning. Keep the `warning` and `wip` **events**.
- **Cut** `persistQueueStats` — a range-partitioned `queue_stats` table with daily partitions provisioned
  by `ensureQueueStatsPartitions` and pruned by `dropOldQueueStatsPartitions`, plus
  `getQueueStatsHistoryBucketed` with min/max/avg aggregation and two downsampling modes. That is ~218
  lines of SQL (`plans.ts:990-1207`) and 641 lines of tests (`queueStatsHistoryTest.ts` 580 +
  `readyHistoryTest.ts` 61) for a time series most users already get from their metrics stack.
- **Cut** `persistWarnings` — the `warning` table, ~90 lines. The events are the valuable part; writing
  them to Postgres is not.

Config that disappears: `persistQueueStats`, `queueStatRetentionDays`, `persistWarnings`,
`warningRetentionDays`, and the `QueueStatsOptions` history fields.

## 7. Drop job spies

**≈200 src · 499 test**

`spy.ts` (134) plus ~80 lines of hooks in `manager.ts`, gated behind `__test__enableSpies`. A test harness
living in the runtime, with 499 lines of its own tests and 192 lines of docs. It belongs in a separate
test package, if anywhere.

Keep the three `__test__` compatibility hooks — those are seam coverage (see #1), not a feature.

---

# Tier 2 — niche user-facing features

These break API. Each is individually optional.

## 8. Pub/sub

**~75 src · 131 test.** A `subscription (event, name)` table, three SQL statements, and a fan-out.
`publish()` is `Promise.allSettled(rows.map(send))` — **it silently swallows every send failure**
(`manager.ts:843-849`). A fan-out primitive that can lose jobs without telling you is worse than not
having one; users who want this can loop over `send()` themselves and see the errors.

## 9. The `exclusive` and `key_strict_fifo` queue policies

**~60 src · ~400 test.** The six policies are not entangled — each is an independent partial index gated
on `policy = '<name>'`, and the insert paths use plain `ON CONFLICT DO NOTHING` with no per-policy branch.
There is no policy validation in `attorney.ts` at all; `manager.ts:1712` asserts
`policy in plans.QUEUE_POLICIES`, so **deleting the two keys from the frozen object auto-rejects them**.

- `exclusive` — one unique index (`job_i6`), zero runtime branches.
- `key_strict_fifo` — one unique index (`job_i8`), one CHECK constraint, and the only policy with
  JS-side behavior: `getBlockedKeys()` plus four call sites in `manager.ts`.

`standard`, `short`, `singleton`, and `stately` cover the mainstream cases and stay.

## 10. `JobMatchStrategy` on update/upsert

**~25 src.** The entire SQL contribution is four lines (`plans.ts:2340-2342`, interpolated at `:2370`).
The default is `'newest'`, so hardcoding `ORDER BY job.created_on DESC LIMIT 1` **preserves today's
behavior exactly**. The only capability lost is `match: 'all'`, and since `UpdateResponse.jobs` is already
an array, the response shape is unchanged.

## 11. `localGroupConcurrency` — cut this, not `tiers`

**~200 src · 571 test.** This is where the LOC ranking misleads.

`tiers` looks like the smaller cut (~20 lines of validation, one `COALESCE`, one jsonb param) — but it
lives *inside* the `fetchNextJob` CTEs, the highest-churn SQL in the repo, and removing the `group_tier`
column touches eight write sites. High merge cost, small payoff. **Keep it.**

`localGroupConcurrency` is the better cut: a per-process *approximation* of group limits (3 Maps, 6
private methods in `manager.ts`, plus a `restore()` round-trip for over-fetched jobs), mutually exclusive
with the real DB-coordinated `groupConcurrency` (`attorney.ts:350-353`), with 571 lines of tests across
three files. It is pure JS with no DDL — a clean, low-merge-cost delete. Users who need group limits
should use the correct cluster-wide one.

**Unrelated bug found while measuring this:** `checkFetchArgs` (`attorney.ts:421-429`) never calls
`validateGroupConcurrencyConfig`, so a `groupConcurrency` passed to `fetch()` bypasses validation
entirely. Worth fixing regardless of what is cut.

## 12. `getJobById`

**~10 src.** The repo's only `@deprecated` (`index.ts:390-395`). `findJobs()` supersedes it.

---

# Keep — deliberately

- **The compatibility-flag seam.** Per decision 1, and `REPORT.md` is right that
  `noSkipLocked` / `noMultiMutationCte` / `noAdvisoryLocks` / `noTablePartitioning` / `noListenNotify`
  describe SQLite accurately. It *understates* the case by omitting two more that also fit:
  `noIndexProgressView` (SQLite has no `pg_stat_progress_create_index`) and `noCoveringIndexes`
  (no `INCLUDE`).
- **Flows + navigator** (~700 src). A headline feature, and the design is good — resolution runs off the
  completion hot path in a background poller, so completion stays join-free.
- **Cron** (~320 src). Commonly used, cleanly isolated in `timekeeper.ts`, and the clock-skew handling
  people assume is complex is ~40 lines.
- **LISTEN/NOTIFY** (~330 src). Already optional by design — a latency hint that degrades to polling, never
  required for correctness.
- **Partitioning, dead letter + redrive, priority, heartbeats, per-job results, base `groupConcurrency`,
  the `warning` / `wip` events.** All earn their LOC.

# Sequencing

Dependency-ordered, file-deletions first:

1. **Drift** (#2) — must precede #3/#4; `bam` is in `FIXED_MANAGED_TABLES` and `detectDrift` reads
   `getIncompleteBamCommands`. Also removes the `gen:manifest` gate, so everything after is cheaper.
2. **Migrations** (#3) — unlocks #4.
3. **BAM** (#4) — now provably dead.
4. **CLI** (#5) — collapses last and cheapest, once `doctor`/`migrate`/`rollback` have no targets.
5. **Backend profiles** (#1) — with the four replacement `__test__` hooks in the same change.
6. **Stats history + warning persistence** (#6), **spies** (#7).
7. **Tier 2**, in any order.

**One schema consequence:** Tier 1 and Tier 2 both change fresh-install DDL — dropping the `bam`,
`queue_stats`, `warning`, and `subscription` tables and indexes `job_i6` / `job_i8`. Land them as a
**single schema-version bump**, not one per cut.

# What this costs

- No in-place upgrade from an existing pg-boss database (decision 2).
- No `doctor`, no CLI, no drift detection — schema damage becomes a silent failure mode rather than a
  reported one.
- No time-series queue stats; users need an external metrics stack for history.
- Tier 2 breaks API: pub/sub, two policies, `match: 'all'`, `localGroupConcurrency`, `getJobById`.
- **The honest one:** every cut inside `plans.ts` / `manager.ts` / `attorney.ts` is a permanent upstream
  merge tax. That is precisely why the ordering above front-loads whole-file deletions, where the
  conflict cost is a one-time `git rm`.

---

# Appendix

### `src/` by size

| LOC | File | | LOC | File |
|---|---|---|---|---|
| 3029 | `plans.ts` | | 249 | `contractor.ts` |
| 2069 | `schema.json` *(generated)* | | 241 | `db.ts` |
| 2036 | `manager.ts` | | 175 | `bam.ts` |
| 1288 | `migrationStore.ts` | | 173 | `navigator.ts` |
| 1133 | `types.ts` | | 166 | `worker.ts` |
| 747 | `attorney.ts` | | 134 | `spy.ts` |
| 614 | `index.ts` | | 113 | `tools.ts` |
| 603 | `cli.ts` | | 96 | `notifier.ts` |
| 503 | `drifter.ts` | | 66 | `adapters/pglite.ts` |
| 330 | `adapters/bun.ts` | | 35 | `warning.ts` |
| 292 | `boss.ts` | | 5 | `adapters/index.ts` |
| 256 | `timekeeper.ts` | | | |

### Largest test files

| LOC | File | Cut |
|---|---|---|
| 1055 | `driftTest.ts` | #2 |
| 922 | `migrationTest.ts` | #3 |
| 671 | `cliTest.ts` | #5 |
| 580 | `queueStatsHistoryTest.ts` | #6 |
| 561 | `flowTest.ts` | keep |
| 499 | `spyTest.ts` | #7 |
| 492 | `scheduleTest.ts` | keep |
| 482 | `bamTest.ts` | #4 |
| 437 | `queuePolicyTest.ts` | partial, #9 |
| 406 | `distributedDatabaseTest.ts` | keep — seam coverage |

### CI reality check

`.github/workflows/ci.yml` matrix: `standard`, `distributed`, `bun-driver` (bun `1` and `canary`), plus a
separate `pglite` job. **No CockroachDB, YugabyteDB, or Citus job exists.** Those three backends are
locally-runnable-only and therefore unverified on every commit — the strongest argument for cut #1.
