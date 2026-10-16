# ORM transaction adapters

pg-boss operations such as `send()`, `insert()`, `fetch()`, and `complete()` accept a `db` option that lets you run them inside an existing database transaction. Use it to make creating or completing a job atomic with your application's own writes. If the transaction rolls back, so does the job.

> [!NOTE]
> To go the other way, and commit a worker's writes with the job's completion, use a [transactional worker](./workers.md#work-name-options-handler). pg-boss opens that transaction itself, so the ORM adapters below, which wrap a transaction you already have, don't apply to it.

Each adapter wraps the ORM's transaction object as a pg-boss `Db` (the `executeSql` interface), so pg-boss can run its own SQL in your transaction.

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

The Drizzle adapter requires the `sql` tagged-template function from `drizzle-orm` as its second argument. pg-boss uses it to build parameterized queries through Drizzle's public API, so it doesn't need `drizzle-orm` as a runtime dependency. The adapter supports the `node-postgres`, `postgres-js` and `bun-sql` drivers. For `bun-sql`, see [Bun](../database-backends.md#bun-driver), which covers running pg-boss on Bun's client as well as enqueueing through it.

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

## Rollback behavior

When the ORM transaction rolls back, whether you roll it back or an error is thrown, every pg-boss operation run through the adapter rolls back with it. Keeping your application's writes and its job scheduling atomic is the main reason to use these adapters.
