# Plan: harden the queue-metadata cache against wrong-empty driver results

## Context

The `bun-driver / bun: '1'` CI lane fails intermittently on
`distributedDatabaseTest > should handle high concurrency without duplicates` with
`Queue <name> does not exist`, thrown from `Manager.getQueueCache` during a burst of concurrent
`send()`s. Instrumentation showed the root cause: on Bun 1.3.x, under mixed concurrent load, a
parameterized `getQueues` SELECT can **succeed with an empty result set** for a row that is
committed and visible — no error is raised, so neither the 25P02-retry workaround (PR #6) nor the
private transaction client (PR #3) can catch it. The defect is fixed upstream in Bun 1.4 (the
canary lane passes consistently), and it predates the sqlite PR (master has failed the same
lane/test since #6's own merge commit).

A driver that returns wrong results cannot be fully engineered around client-side. What CAN be
fixed is pg-boss's own amplification: today, **one** wrong-empty read becomes a user-visible
failure. Three structural choices amplify it (all in `src/manager.ts`):

1. **Evict-only cache.** `createQueue()`/`updateQueue()` end with `#evictQueueCache(name)`
   (manager.ts:1872, :1941). The most common next action — sending to the just-created queue —
   is therefore *guaranteed* a cache miss, so N concurrent sends issue N live lookups in the
   busiest window. The failing test's 50-send storm funnels ~50 `getQueues` calls through the
   driver at peak load.
2. **A single uncorroborated negative read is treated as proof of nonexistence.**
   `getQueueCache` (manager.ts:583-601): miss → one `getQueue(name)` → `null` ⇒ throw.
3. **Wholesale cache replacement on refresh.** `onCacheQueues` (manager.ts:573-581) does
   `this.queues = result.reduce(...)` — one lying empty refresh silently wipes every entry
   (also observed in the instrumented run).

This plan removes the amplifiers. The result is also a simpler cache lifecycle
(create ⇒ known, rather than create ⇒ unknown ⇒ lazy refill under load). It does not change any
SQL, so the postgres byte-identity snapshot is untouched and every backend is affected equally
(the hardening is generic — it also shrinks the window for real transient faults on any driver).

**Invariants that must not move:**
- A genuinely missing queue still throws `Queue <name> does not exist` from the same call sites.
- `createQueue` on an existing queue remains a no-op that preserves the queue's original
  configuration (`ON CONFLICT DO NOTHING` semantics) — so write-through must never populate the
  cache from the *requested* options; only from a read-back of the authoritative row.
- Cache staleness stays bounded by `queueCacheIntervalSeconds`, plus at most one extra interval
  in the new two-consecutive-empties rule below.
- No plans.ts / SQL changes; `test/plansSnapshot.sql` must not change.

## Changes (all in `src/manager.ts`)

### 1. Write-through on createQueue / updateQueue

After the DDL statement succeeds, read the row back and populate the cache instead of evicting:

```ts
// createQueue (manager.ts:1870-1872) and updateQueue (manager.ts:1939-1941)
await this.db.executeSql(sql)
await this.#refreshQueueCacheEntry(name)
```

with one private helper:

```ts
// Read-back, not synthesis: createQueue on an existing queue is a config-preserving no-op
// (ON CONFLICT DO NOTHING), so the DB row is the only truth worth caching. An empty read-back
// (transient driver fault) degrades to today's behavior — evict and let getQueueCache refill.
async #refreshQueueCacheEntry (name: string) {
  const queue = await this.getQueue(name)
  if (queue) this.queues![name] = queue
  else this.#evictQueueCache(name)
}
```

`deleteQueue` keeps its explicit evict (manager.ts:1964). The dead-letter existence check inside
`createQueue` (`getQueueCache(options.deadLetter)`) is unchanged.

Effect: in-process create→send flows never take the miss path, which deletes the entire observed
failure window (the storm of cold lookups immediately after creation).

### 2. Corroborate negative lookups in getQueueCache

An empty per-name lookup is re-verified once before pg-boss concludes the queue does not exist:

```ts
// getQueueCache (manager.ts:592-596)
queue = await this.getQueue(name) ?? await this.getQueue(name)

if (!queue) {
  throw new Error(`Queue ${name} does not exist`)
}
```

(Write it as an explicit second call with a comment, not a retry loop — the point is
corroboration of a *negative*, not resilience of the query. Positive results are never re-read.)

A truly missing queue answers "absent" twice and still throws — same contract, one extra
round-trip on what is already the error path. A transient wrong-empty must now occur twice in a
row on a path that change 1 has made rare.

### 3. Merge-with-corroboration in onCacheQueues

Replace the wholesale assignment with an upsert-and-prune that only accepts an empty snapshot
when it is confirmed by two consecutive refreshes:

```ts
// onCacheQueues (manager.ts:573-581); add `#lastRefreshEmpty = false` field
const queues = await this.getQueues()

if (queues.length === 0 && !this.#lastRefreshEmpty && this.queues && Object.keys(this.queues).length) {
  // One empty snapshot against a non-empty cache is not proof (see PLAN.md): keep the cache,
  // require the next refresh to confirm before wiping.
  this.#lastRefreshEmpty = true
  return
}

this.#lastRefreshEmpty = queues.length === 0
this.queues = queues.reduce(...)   // unchanged shape from here
```

Legitimate "all queues deleted elsewhere" converges one interval later than today; cross-process
deletion of *some* queues is unaffected (any non-empty snapshot still prunes missing names
immediately via the full rebuild). The initial `await this.onCacheQueues()` in `start()` is
unaffected (`this.queues` is undefined on the first pass, so an empty first snapshot installs
normally).

## Tests to add (`test/queueCacheTest.ts`, runs on every backend)

Fake-driven where the driver must lie — wrap `config.db` the way `bunAdapterTest`'s fakes and the
earlier instrumentation do:

1. **Write-through**: create a queue, then `send()` with a db wrapper that counts `getQueues`
   executions — assert zero live lookups between create and send (cache was populated by
   createQueue's read-back, and the send hit it).
2. **No-op create preserves config in cache**: `createQueue(name, { retryLimit: 3 })`, then
   `createQueue(name, { retryLimit: 9 })` — assert `getQueueCache(name).retryLimit === 3` (the
   read-back cached the surviving row, not the ignored request).
3. **Corroborated negative, driver lies once**: wrapper makes the first `getQueues([name])`
   return `{ rows: [] }` and passes the second through — `send()` succeeds.
4. **Corroborated negative, queue truly missing**: both lookups empty — `send()` throws
   `Queue ... does not exist` (existing queueTest expectations must also stay green unchanged).
5. **Refresh wipe protection**: populate the cache, force one `onCacheQueues` with an
   empty-lying wrapper — assert entries survive; force a second consecutive empty — assert the
   cache is cleared.
6. **updateQueue write-through**: update `retryLimit`, assert the cache entry reflects it
   without any subsequent live lookup.

## Verification

1. `bun run tsc`, `eslint .`, and the snapshot test — `test/plansSnapshot.sql` must be
   byte-identical (this plan touches no SQL).
2. Full matrices, all green as before: `bun run test` (standard), `test:distributed`,
   `test:pglite`, `test:sqlite`, `test:bun`.
3. **The reproducer, before/after**: on Bun 1.3.14,
   `DB_TYPE=bun bun --bun vitest run test/distributedDatabaseTest.ts -t "high concurrency"`
   in a loop of ≥6 runs. Baseline on the current branch fails ~2 of 3; after this change it must
   pass every run (the storm no longer exists, and a residual lie must strike twice in a row).
   `multiMasterTest` under `DB_TYPE=bun` in a loop as well, since it is the other
   concurrency-sensitive file.
4. Watch that the two `__test__throw_queueCache`-based tests and `deleteQueue`'s
   swallow-the-lookup semantics (manager.ts:1953-1960) still behave — deleteQueue's existence
   probe now costs a corroborating second read when the queue is absent, which is fine (cold
   path), but the test expectations around it must not change.

## Out of scope (recorded so they aren't relitigated)

- **The categorical endpoint** — making `send()` fully DB-arbitrated (in-SQL `q.notify` gate,
  CHECK-constraint-driven `key_strict_fifo` error translation, parent-table partition routing)
  so the cache carries zero correctness weight. Bigger change, touches postgres SQL (snapshot
  churn), and `fetch`/`complete` would still need the cache; revisit only if driver-level trust
  issues recur on ≥1.4.
- **CI posture**: whether `bun-driver / bun: '1'` regains `optional: true` is independent of
  this fix — if the reproducer loop is clean after this change, the lane can stay blocking.
- **Upstream**: the Bun 1.3.x wrong-empty-result behavior under concurrent load deserves a
  standalone report (the instrumented `getQueues` evidence is in this repo's history);
  ISSUES.txt #3 should gain a paragraph describing this silent variant either way.
