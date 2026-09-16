# PGliteWorker leader-change harness

Manual browser checks for `src/adapters/pglite.ts`. Not part of `npm test`: real leader election
needs `navigator.locks` and real `Worker`s, and Node has neither.

Run it when you change the adapter's leader-change handling, its session statements, or its error
handling around `ROLLBACK`.

## Run

```sh
npm run test:browser
```

Serves the repo at http://localhost:5199 and opens `/test/browser/index.html`, which runs on load.
The adapter is imported straight from source, so whatever is checked out is what gets tested.

## Why it exists

The vitest tests in `test/pgliteAdapterTest.ts` drive the same seams against a worker-shaped fake.
That is enough for the adapter's own logic, but it cannot show how a real `PGliteWorker` behaves —
and two of the things worth knowing were only visible here:

- A statement that **holds** the transaction lock when leadership moves never settles on its own.
  Its rpc rejects, but `_runExclusiveTransaction`'s `finally` posts `_releaseTransactionLock` to a
  tab channel the new leader has not attached to, so nothing replies and no second `leader-change`
  fires to reject it. The adapter fails such a statement itself rather than hang; that is what the
  "does not hang" check pins. A statement still *queued* on the lock is fine — that throw precedes
  the `try`.
- The feared reconnect window is not real. `query()` gates on `_checkReady()` → `waitReady`, and the
  `leader-here` handler clears `connected` before dispatching, so a reapply issued from
  `onLeaderChange` waits for re-registration instead of being dropped.

## How it works

No multiple tabs needed. `navigator.locks` is origin-scoped and shared across dedicated workers, and
the election lock is `pglite-election-lock:${id}` with `id` settable per instance — so several
`PGliteWorker`s on one page contend for one lock. Closing the leader's instance terminates its
worker, releases the lock, and promotes the next.

Every await is bounded at 15s and a `TIMEOUT` is reported as a failure, so a hang is a result rather
than a hung page.

## Reproducing the defects

Check out a copy of `src/adapters/pglite.ts` from before this work and refresh. The harness detects
an adapter with no `setSessionStatements()`, says so, and applies the `SET` the way the old code
left callers to — so the survival checks fail as the defect instead of erroring on a missing method,
and the lock holder reports `HUNG`.

## Gotchas

- The cross-instance bleed check must run **before** the leader change. After it, it only restates
  whatever the reapply did.
- Do not cache-bust with a dynamic `import(\`./harness.js?t=${Date.now()}\`)` — vite's
  dynamic-import-vars plugin rejects it ("Unknown variable dynamic import") and the page hangs on
  "starting…". The `Cache-Control: no-store` header in `vite.config.mjs` is what keeps an edited
  harness out of the browser's module cache.
- Results are also on `window.__RESULTS__` and in one `HARNESS_DONE` console line, if you want to
  drive this from Playwright.
