# ORM Transaction Adapters

pg-boss operations such as `send()`, `insert()`, `fetch()`, and `complete()` accept a `db` option that lets you run them inside an existing database transaction. This is how you ensure that job creation (or completion) is atomic with your application's own writes. If the transaction rolls back, so does the job.

> [!NOTE]
> To go the other way, and commit a worker's writes with the job's completion, use a [transactional worker](./workers.md#work-name-options-handler). pg-boss opens that transaction itself, so the ORM adapters below, which wrap a transaction you already have, do not apply to it.

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

The Drizzle adapter requires the `sql` tagged-template function from `drizzle-orm` as a second argument. This allows pg-boss to construct parameterised queries through Drizzle's public API without adding `drizzle-orm` as a runtime dependency. The `node-postgres`, `postgres-js` and `bun-sql` drivers are supported. For `bun-sql`, see [Bun](../database-backends.md#bun-driver), which covers running pg-boss on Bun's client as well as enqueueing through it. To run pg-boss itself on the client a `postgres-js` Drizzle instance wraps, see [postgres.js](../database-backends.md#postgres-js-driver).

```ts
import { fromDrizzle } from 'pg-boss'
import { sql } from 'drizzle-orm'

await db.transaction(async (tx) => {
  await tx.insert(orders).values({ item: 'widget', qty: 1 })

  await boss.send('order-processing', { item: 'widget' }, { db: fromDrizzle(tx, sql) })
})
```

## postgres.js

Without an ORM, a postgres.js `sql.begin()` transaction goes through the same adapter that runs pg-boss on a postgres.js client. See [postgres.js](../database-backends.md#postgres-js-driver).

```ts
import { fromPostgresJs } from 'pg-boss'

await sql.begin(async (tx) => {
  await tx`insert into orders (item, qty) values ('widget', 1)`

  await boss.send('order-processing', { item: 'widget' }, { db: fromPostgresJs(tx) })
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

## Rollback behaviour

When the ORM transaction is rolled back (either explicitly or by throwing an error), all pg-boss operations executed through the adapter are rolled back as well. This is the primary reason to use these adapters: it guarantees atomicity between your application writes and job scheduling.
