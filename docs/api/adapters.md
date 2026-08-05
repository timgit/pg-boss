# Database Adapters

pg-boss operations such as `send()`, `insert()`, `fetch()`, and `complete()` accept a `db` option that lets you run them inside an existing database transaction. This is how you ensure that job creation (or completion) is atomic with your application's own writes — if the transaction rolls back, so does the job.

Each adapter wraps a driver's connection or transaction object as a pg-boss `Db` (the `executeSql` interface), so pg-boss can execute its own SQL within your transaction.

```ts
interface Db {
  executeSql(text: string, values: any[]): Promise<{ rows: any[] }>;
}
```

pg-boss ships with `fromBunSql` for Bun's built-in `SQL` client against PostgreSQL, `fromPglite` for embedded PGlite, and `fromBunSqlite` for embedded SQLite through Bun's `SQL` client (see [Database Backends](../database-backends.md#pglite-embedded)).

## Bun

Bun's built-in [`SQL`](https://bun.com/docs/api/sql) client is a driver rather than an ORM, so `fromBunSql` covers both uses: it can back a whole pg-boss instance in place of the `pg` pool, and it can scope a single operation to a `sql.begin()` transaction. Bun hands out the same shape for a pool and for a transaction, so one function serves both.

```ts
import { SQL } from 'bun'
import PgBoss, { fromBunSql } from 'pg-boss'

const sql = new SQL('postgres://user:pass@localhost:5432/mydb')

// drive pg-boss entirely through Bun — no `pg` pool
const boss = new PgBoss({ db: fromBunSql(sql) })
await boss.start()

// or create a job inside your own transaction
await sql.begin(async (tx) => {
  await tx`INSERT INTO orders (item, qty) VALUES (${'widget'}, ${1})`

  await boss.send('order-processing', { item: 'widget' }, { db: fromBunSql(tx) })
})
```

Bun talks to real PostgreSQL, so leave `backend` at its default `postgres` — no compatibility flags apply. As with every adapter, the `SQL` client's lifecycle is yours: pg-boss never opens or closes it.

See [Bun.SQL](../database-backends.md#bunsql) for the driver-level details — LISTEN/NOTIFY, prepared statements, and multi-statement blocks.

## SQLite (Bun)

`fromBunSqlite` adapts Bun's `SQL` client opened on a `sqlite://` URL. It always backs a whole
pg-boss instance (pair it with `backend: 'sqlite'`), and pg-boss's tables live in the same
database file as your application's.

```ts
import { SQL } from 'bun'
import PgBoss, { fromBunSqlite } from 'pg-boss'

const sql = new SQL('sqlite://app.db')
const db = fromBunSqlite(sql)

const boss = new PgBoss({ backend: 'sqlite', db })
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
transaction you open directly, and pg-boss's background writes would interleave into it.

See [SQLite](../database-backends.md#sqlite-embedded-via-bunsql) for the dialect-level details and
limitations.

## Rollback behaviour

When the transaction is rolled back (either explicitly or by throwing an error), all pg-boss operations executed through the adapter are rolled back as well. This is the primary reason to use an adapter — to guarantee atomicity between your application writes and job scheduling.
