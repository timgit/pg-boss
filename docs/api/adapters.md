# Database Adapters

bun-boss operations such as `send()`, `insert()`, `fetch()`, and `complete()` accept a `db` option that lets you run them inside an existing database transaction. This is how you ensure that job creation (or completion) is atomic with your application's own writes — if the transaction rolls back, so does the job.

Each adapter wraps a driver's connection, instance, or transaction object as a bun-boss `Db` (the `executeSql` interface, plus the optional `withTransaction` and `listen` capabilities), so bun-boss can execute its own SQL within your transaction.

```ts
interface Db {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  // Optional. When present, bun-boss runs its multi-statement operations (upsert, the split
  // complete/fail/expire, flow resolution) inside a real transaction; otherwise they run
  // sequentially without atomicity.
  withTransaction?<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  // Optional. Enables LISTEN/NOTIFY (`useListenNotify`); only `fromPglite` implements it.
  listen?(channel: string, onNotification: (payload: string) => void, onReconnect: () => void): Promise<ListenHandle>;
}
```

Only `executeSql` is required. An adapter that omits `withTransaction` still works, but bun-boss falls back to running those multi-statement operations without a transaction — and flow resolution loses atomicity, so a flow that fails part way can leave dependencies partly written (see [Database Backends](../database-backends.md#what-is-different-from-the-postgres-backends)). When a flow fails inside a caller-owned transaction (`{ db }`), the transaction itself stays usable — roll it back rather than committing after a caught flow error.

What the shipped adapters implement:

| adapter | `executeSql` | `withTransaction` | `listen` |
|---|---|---|---|
| `fromBunSql` | ✅ | ❌ | ❌ |
| `fromBunSqlite` | ✅ | ✅ | ❌ |
| `fromPglite` | ✅ | ✅ | ✅ |

Write `$1, $2` placeholders in your own SQL on every backend; the adapter translates them to whatever the driver expects.

bun-boss ships with `fromBunSql` for Bun's built-in `SQL` client against PostgreSQL, `fromPglite` for embedded PGlite, and `fromBunSqlite` for embedded SQLite through Bun's `SQL` client (see [Database Backends](../database-backends.md)).

## Bun

Bun's built-in [`SQL`](https://bun.com/docs/api/sql) client is a driver rather than an ORM, so `fromBunSql` covers both uses: it can back a whole bun-boss instance with a client you own (the built-in driver wraps its own client with this same adapter), and it can scope a single operation to a `sql.begin()` transaction. Bun hands out the same shape for a pool and for a transaction, so one function serves both.

```ts
import { SQL } from 'bun'
import { BunBoss, fromBunSql } from 'bun-boss'

const sql = new SQL('postgres://user:pass@localhost:5432/mydb')

// back bun-boss with a client your application already owns
const boss = new BunBoss({ db: fromBunSql(sql) })
await boss.start()

// or create a job inside your own transaction
await sql.begin(async (tx) => {
  await tx`INSERT INTO orders (item, qty) VALUES (${'widget'}, ${1})`

  await boss.send('order-processing', { item: 'widget' }, { db: fromBunSql(tx) })
})
```

Bun talks to real PostgreSQL, so leave `backend` at its default `postgres` — no compatibility flags apply. As with every adapter, the `SQL` client's lifecycle is yours: bun-boss never opens or closes it.

`fromBunSql` implements `executeSql` only — it has no `withTransaction`. Backing a whole instance with it therefore runs bun-boss's own multi-statement operations (upsert, the split complete/fail/expire, flow resolution) without a transaction, unlike the built-in driver, which does supply `withTransaction`. Use it for the per-operation `{ db }` case, or accept that trade-off.

See [Bun.SQL](../database-backends.md#bunsql-the-built-in-driver) for the driver-level details — LISTEN/NOTIFY, prepared statements, and multi-statement blocks.

## PGlite

`fromPglite` adapts a PGlite instance. Like SQLite it backs a whole bun-boss instance (pair it with
`backend: 'pglite'`), and bun-boss's tables live in the same in-process database as your
application's. It is the only shipped adapter that implements `listen`, so it is the only one that
can serve `useListenNotify`.

```ts
import { PGlite } from '@electric-sql/pglite'
import { BunBoss, fromPglite } from 'bun-boss'

const pglite = new PGlite('./my-app-data')
const db = fromPglite(pglite)

const boss = new BunBoss({ backend: 'pglite', db })
await boss.start()
```

Sharing the database does not by itself make a job atomic with your writes — a plain `send()`
outside a transaction commits on its own. To get atomicity, open the transaction through the
adapter's `withTransaction` and pass its handle as the operation's `db`:

```ts
await db.withTransaction!(async (tx) => {
  await tx.executeSql('INSERT INTO orders (item, qty) VALUES ($1, $2)', ['widget', 1])
  await boss.send('order-processing', { item: 'widget' }, { db: tx })
})
```

`fromPglite` is typed as the base `Db`, on which `withTransaction` is optional, so TypeScript needs
the assertion (or a local check) before the call; `fromBunSqlite` narrows its return type instead,
which is why the SQLite sample below needs neither.

See [PGlite](../database-backends.md#pglite-embedded) for the instance-level details and
limitations.

## SQLite (Bun)

`fromBunSqlite` adapts Bun's `SQL` client opened on a `sqlite://` URL. It always backs a whole
bun-boss instance (pair it with `backend: 'sqlite'`), and bun-boss's tables live in the same
database file as your application's.

```ts
import { SQL } from 'bun'
import { BunBoss, fromBunSqlite } from 'bun-boss'

const sql = new SQL('sqlite://app.db')
const db = fromBunSqlite(sql)

const boss = new BunBoss({ backend: 'sqlite', db })
await boss.start()
```

Sharing the database file does not by itself make a job atomic with your writes — a plain `send()`
outside a transaction commits on its own. To get atomicity, open the transaction through the
adapter's `withTransaction` and pass its handle as the operation's `db`:

```ts
await db.withTransaction(async (tx) => {
  await tx.executeSql('INSERT INTO orders (item, qty) VALUES ($1, $2)', ['widget', 1])
  await boss.send('order-processing', { item: 'widget' }, { db: tx })
})
```

Always use `withTransaction` rather than issuing `BEGIN` yourself on the shared `SQL` instance:
the adapter serializes its own statements on the single logical connection, but it cannot see a
transaction you open directly, and bun-boss's background writes would interleave into it.

See [SQLite](../database-backends.md#sqlite-embedded-via-bunsql) for the dialect-level details and
limitations.

## Rollback behaviour

When the transaction is rolled back (either explicitly or by throwing an error), all bun-boss operations executed through the adapter are rolled back as well. This is the primary reason to use an adapter — to guarantee atomicity between your application writes and job scheduling.
