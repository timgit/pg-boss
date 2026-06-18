# PGlite

[PGlite](https://pglite.dev) is a complete PostgreSQL build packaged as a WASM library that runs
embedded in your Node.js (or browser) process — no separate database server. Because PGlite is real
PostgreSQL, pg-boss runs against it with **no compatibility flags**: declarative partitioning,
deferrable constraints, advisory locks, covering indexes, `SELECT FOR UPDATE SKIP LOCKED`, and the
multi-statement migration DDL all work.

PGlite's one meaningful difference from a normal PostgreSQL deployment is that it is
**single-connection and embedded** — it is reached through the `@electric-sql/pglite` client rather
than the `pg` connection pool. pg-boss connects to it through the `fromPglite` adapter.

## Usage

Install PGlite alongside pg-boss:

```bash
npm install @electric-sql/pglite
```

Construct a PGlite instance, wrap it with `fromPglite`, and select the `pglite`
[backend profile](distributed-databases.md#backend-profiles):

```ts
import { PGlite } from '@electric-sql/pglite'
import PgBoss, { fromPglite } from 'pg-boss'

const pglite = new PGlite('idb://my-app')   // or new PGlite() for in-memory

const boss = new PgBoss({
  backend: 'pglite',
  db: fromPglite(pglite)
})

await boss.start()

await boss.createQueue('email')
await boss.send('email', { to: 'user@example.com' })

const [job] = await boss.fetch('email')
// ... do work ...
await boss.complete('email', job.id)
```

## Lifecycle is yours to manage

Unlike the default `pg`-pool connection, pg-boss does **not** open or close the PGlite instance —
you own it. Construct it before `boss.start()` and close it after `boss.stop()`:

```ts
await boss.stop()
await pglite.close()
```

This mirrors the [ORM transaction adapters](api/adapters.md): pg-boss only calls `executeSql` on the
object you provide.

## Single-connection considerations

PGlite serializes everything through one connection. pg-boss's background loops (maintenance,
scheduling, monitoring) and your workers all share that single connection, so queries are processed
one at a time. This is fine functionally — PGlite queues requests internally — but you should keep
concurrency modest:

- There is no benefit to large `batchSize` or many concurrent workers; they cannot run in parallel.
- For embedded / local-first / testing workloads (PGlite's sweet spot) this is rarely a constraint.
- For high-throughput multi-worker queues, use a server-based PostgreSQL instead.

## Persistence

PGlite supports in-memory, IndexedDB (browser), and filesystem persistence — see the
[PGlite docs](https://pglite.dev/docs/filesystems). pg-boss treats all of them identically; the job
schema and data persist wherever the PGlite instance stores its data directory.
