# Database Adapters

pg-boss operations such as `send()`, `insert()`, `fetch()`, and `complete()` accept a `db` option that lets you run them inside an existing database transaction. This is how you ensure that job creation (or completion) is atomic with your application's own writes — if the transaction rolls back, so does the job.

Each adapter wraps the ORM's transaction object as a pg-boss `Db` (the `executeSql` interface), so pg-boss can execute its own SQL within your transaction.

```ts
interface Db {
  executeSql(text: string, values: any[]): Promise<{ rows: any[] }>;
}
```

## Knex

```ts
import { fromKnex } from 'pg-boss'

await knex.transaction(async (trx) => {
  // your application writes ...
  await trx('orders').insert({ item: 'widget', qty: 1 })

  // schedule a pg-boss job in the same transaction
  await boss.send('order-processing', { item: 'widget' }, { db: fromKnex(trx) })
})
```

## Kysely

```ts
import { fromKysely } from 'pg-boss'

await db.transaction().execute(async (trx) => {
  await trx.insertInto('orders').values({ item: 'widget', qty: 1 }).execute()

  await boss.send('order-processing', { item: 'widget' }, { db: fromKysely(trx) })
})
```

## Drizzle

The Drizzle adapter requires the `sql` tagged-template function from `drizzle-orm` as a second argument. This allows pg-boss to construct parameterised queries through Drizzle's public API without adding `drizzle-orm` as a runtime dependency. Both the `node-postgres` and `postgres-js` drivers are supported.

```ts
import { fromDrizzle } from 'pg-boss'
import { sql } from 'drizzle-orm'

await db.transaction(async (tx) => {
  await tx.insert(orders).values({ item: 'widget', qty: 1 })

  await boss.send('order-processing', { item: 'widget' }, { db: fromDrizzle(tx, sql) })
})
```

## Prisma

Requires Prisma v7+ with `@prisma/adapter-pg`.

```ts
import { fromPrisma } from 'pg-boss'

await prisma.$transaction(async (tx) => {
  await tx.order.create({ data: { item: 'widget', qty: 1 } })

  await boss.send('order-processing', { item: 'widget' }, { db: fromPrisma(tx) })
})
```

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

## Rollback behaviour

When the ORM transaction is rolled back (either explicitly or by throwing an error), all pg-boss operations executed through the adapter are rolled back as well. This is the primary reason to use these adapters — to guarantee atomicity between your application writes and job scheduling.
