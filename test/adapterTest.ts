import { it, afterAll } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import pg from 'pg'

import { fromKnex, fromKysely, fromDrizzle, fromPrisma } from '../src/adapters/index.ts'

// These adapters wrap real ORM connections that reach Postgres over a connection string; PGlite is
// in-process only, so the whole file is skipped under PGlite (fromPglite is covered separately).
const describe = helper.describePglite

import knex, { type Knex } from 'knex'
import { Kysely, PostgresDialect } from 'kysely'
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js'
import { sql as drizzleSql } from 'drizzle-orm'
import postgres from 'postgres'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const config = helper.getConfig()
const connString = `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`

describe('knex adapter', () => {
  let db: Knex

  afterAll(async () => {
    if (db) await db.destroy()
  })

  it('should execute sql through knex transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    db = knex({ client: 'pg', connection: connString })

    let jobId: string | undefined
    await db.transaction(async (trx) => {
      const adapter = fromKnex(trx)
      const result = await adapter.executeSql(
        `INSERT INTO ${ctx.schema}.job (name, data, state)
         VALUES ($1, $2, 'created')
         RETURNING id`,
        [ctx.schema, '{}']
      )
      jobId = result.rows[0]?.id
    })

    expect(jobId).toBeDefined()
  })

  it('should rollback on knex transaction failure', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) db = knex({ client: 'pg', connection: connString })

    let jobId: string | undefined
    try {
      await db.transaction(async (trx) => {
        const adapter = fromKnex(trx)
        const result = await adapter.executeSql(
          `INSERT INTO ${ctx.schema}.job (name, data, state)
           VALUES ($1, $2, 'created')
           RETURNING id`,
          [ctx.schema, '{}']
        )
        jobId = result.rows[0]?.id
        throw new Error('force rollback')
      })
    } catch {}

    expect(jobId).toBeDefined()
    const check = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(check.rows.length).toBe(0)
  })

  it('should handle repeated parameter placeholders (knex)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) db = knex({ client: 'pg', connection: connString })

    const result = await db.transaction(async (trx) => {
      const adapter = fromKnex(trx)
      return adapter.executeSql(
        'SELECT $1::int as a, $2::int as b, $1::int as c',
        [7, 9]
      )
    })

    expect(result.rows[0]?.a).toBe(7)
    expect(result.rows[0]?.b).toBe(9)
    expect(result.rows[0]?.c).toBe(7)
  })

  it('should handle out-of-order repeated placeholders (knex)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) db = knex({ client: 'pg', connection: connString })

    const result = await db.transaction(async (trx) => {
      const adapter = fromKnex(trx)
      return adapter.executeSql(
        'SELECT $2::int as a, $1::int as b, $2::int as c',
        [10, 20]
      )
    })

    expect(result.rows[0]?.a).toBe(20)
    expect(result.rows[0]?.b).toBe(10)
    expect(result.rows[0]?.c).toBe(20)
  })

  it('should handle results as an array instead of object (knex)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) db = knex({ client: 'pg', connection: connString })

    const result = await db.transaction(async (trx) => {
      const adapter = fromKnex(trx)
      return adapter.executeSql('BEGIN; SELECT 1 as select1; SELECT 2 as select2; COMMIT;')
    })

    expect(result).toHaveProperty('rows')
    expect(result.rows).toStrictEqual([
      { select1: 1 },
      { select2: 2 },
    ])
  })

  it('should update a job through a knex transaction (updateJob mixes literal jsonb ? with $N)', async () => {
    // updateJob's SQL carries ~11 literal jsonb `?` key-exists operators alongside its $N
    // placeholders. knex.raw() scans the whole string for `?` to fill bindings, so those literal
    // occurrences must be escaped; otherwise knex miscounts and throws "Undefined binding(s) detected".
    const boss = ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) db = knex({ client: 'pg', connection: connString })

    const id = await boss.send(ctx.schema, { v: 1 })
    helper.assertTruthy(id)

    const result = await db.transaction(async (trx) =>
      boss.update(ctx.schema, { v: 2 }, { id, db: fromKnex(trx) }))

    expect(result).toEqual({ jobs: [id], updated: 1 })

    const job = await boss.getJobById(ctx.schema, id)
    helper.assertTruthy(job)
    expect(job.data).toEqual({ v: 2 })
  })
})

describe('kysely adapter', () => {
  let db: Kysely<any>

  afterAll(async () => {
    if (db) await db.destroy()
  })

  it('should execute sql through kysely transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    const pool = new pg.Pool({ connectionString: connString })
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })

    const jobId = await db.transaction().execute(async (trx) => {
      const adapter = fromKysely(trx)
      const result = await adapter.executeSql(
        `INSERT INTO ${ctx.schema}.job (name, data, state)
         VALUES ($1, $2, 'created')
         RETURNING id`,
        [ctx.schema, '{}']
      )
      return result.rows[0]?.id
    })

    expect(jobId).toBeDefined()
  })

  it('should execute parameterless sql through kysely transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) {
      const pool = new pg.Pool({ connectionString: connString })
      db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    }

    const result = await db.transaction().execute(async (trx) => {
      const adapter = fromKysely(trx)
      return adapter.executeSql('SELECT 1 as val')
    })

    expect(result.rows[0]?.val).toBe(1)
  })

  it('should rollback on kysely transaction failure', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) {
      const pool = new pg.Pool({ connectionString: connString })
      db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    }

    let jobId: string | undefined
    try {
      await db.transaction().execute(async (trx) => {
        const adapter = fromKysely(trx)
        const result = await adapter.executeSql(
          `INSERT INTO ${ctx.schema}.job (name, data, state)
           VALUES ($1, $2, 'created')
           RETURNING id`,
          [ctx.schema, '{}']
        )
        jobId = result.rows[0]?.id
        throw new Error('force rollback')
      })
    } catch {}

    expect(jobId).toBeDefined()
    const check = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(check.rows.length).toBe(0)
  })

  it('should handle repeated parameter placeholders (kysely)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!db) {
      const pool = new pg.Pool({ connectionString: connString })
      db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    }

    const result = await db.transaction().execute(async (trx) => {
      const adapter = fromKysely(trx)
      return adapter.executeSql(
        'SELECT $1::int as a, $2::int as b, $1::int as c',
        [7, 9]
      )
    })

    expect(result.rows[0]?.a).toBe(7)
    expect(result.rows[0]?.b).toBe(9)
    expect(result.rows[0]?.c).toBe(7)
  })
})

describe('drizzle adapter', () => {
  let pool: pg.Pool

  afterAll(async () => {
    if (pool) await pool.end()
  })

  it('should execute sql through drizzle transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    pool = new pg.Pool({ connectionString: connString })
    const db = drizzle({ client: pool })

    const jobId = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      const result = await adapter.executeSql(
        `INSERT INTO ${ctx.schema}.job (name, data, state)
         VALUES ($1, $2, 'created')
         RETURNING id`,
        [ctx.schema, '{}']
      )
      return result.rows[0]?.id
    })

    expect(jobId).toBeDefined()
  })

  it('should execute parameterless sql through drizzle transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    const db = drizzle({ client: pool })

    const result = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      return adapter.executeSql('SELECT 1 as val')
    })

    expect(result.rows[0]?.val).toBe(1)
  })

  it('should rollback on drizzle transaction failure', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    const db = drizzle({ client: pool })

    let jobId: string | undefined
    try {
      await db.transaction(async (tx) => {
        const adapter = fromDrizzle(tx, drizzleSql)
        const result = await adapter.executeSql(
          `INSERT INTO ${ctx.schema}.job (name, data, state)
           VALUES ($1, $2, 'created')
           RETURNING id`,
          [ctx.schema, '{}']
        )
        jobId = result.rows[0]?.id
        throw new Error('force rollback')
      })
    } catch {}

    expect(jobId).toBeDefined()
    const check = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(check.rows.length).toBe(0)
  })

  it('should handle repeated parameter placeholders (drizzle)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    const db = drizzle({ client: pool })

    const result = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      return adapter.executeSql(
        'SELECT $1::int as a, $2::int as b, $1::int as c',
        [7, 9]
      )
    })

    expect(result.rows[0]?.a).toBe(7)
    expect(result.rows[0]?.b).toBe(9)
    expect(result.rows[0]?.c).toBe(7)
  })

  it('should handle out-of-order repeated placeholders (drizzle)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    const db = drizzle({ client: pool })

    const result = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      return adapter.executeSql(
        'SELECT $2::int as a, $1::int as b, $2::int as c',
        [10, 20]
      )
    })

    expect(result.rows[0]?.a).toBe(20)
    expect(result.rows[0]?.b).toBe(10)
    expect(result.rows[0]?.c).toBe(20)
  })

  it('should handle array parameters bound to ANY($N::uuid[]) (drizzle)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    const db = drizzle({ client: pool })

    const id = 'd1e48017-d11b-4434-a745-90ee6453caef'

    // single-element and multi-element arrays must each bind as one array-typed
    // parameter, not be expanded into a list of scalar placeholders
    const result = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      return adapter.executeSql(
        `SELECT $1::uuid = ANY($2::uuid[]) as single,
                ($1::uuid = ANY($3::uuid[])) as multi`,
        [id, [id], [id, 'a745d11b-d11b-4434-a745-90ee6453caef']]
      )
    })

    expect(result.rows[0]?.single).toBe(true)
    expect(result.rows[0]?.multi).toBe(true)
  })

  it('should handle results as an array instead of object (drizzle)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    const db = drizzle({ client: pool })

    const result = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      return adapter.executeSql('BEGIN;\nSELECT 1 as select1;\nSELECT 2 as select2;\nCOMMIT;')
    })

    expect(result).toHaveProperty('rows')
    expect(result.rows).toStrictEqual([
      { select1: 1 },
      { select2: 2 },
    ])
  })
})

// postgres.js returns rows as a flat array instead of node-postgres's { rows } object, so the
// adapter has to recognize that shape rather than flat-mapping a missing `rows` property (#852).
describe('drizzle adapter (postgres-js)', () => {
  let client: ReturnType<typeof postgres>

  afterAll(async () => {
    if (client) await client.end()
  })

  const getDb = () => {
    if (!client) client = postgres(connString)
    return drizzlePostgresJs({ client })
  }

  it('should execute sql through a postgres-js drizzle transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = getDb()

    const jobId = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      const result = await adapter.executeSql(
        `INSERT INTO ${ctx.schema}.job (name, data, state)
         VALUES ($1, $2, 'created')
         RETURNING id`,
        [ctx.schema, '{}']
      )
      return result.rows[0]?.id
    })

    expect(jobId).toBeDefined()
  })

  it('should send a job through a postgres-js drizzle transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = getDb()
    const queue = ctx.bossConfig.schema
    await ctx.boss.createQueue(queue)

    const jobId = await db.transaction(async (tx) => {
      return ctx.boss!.send(queue, { hello: 'world' }, { db: fromDrizzle(tx, drizzleSql) })
    })

    expect(jobId).toBeDefined()

    const job = await ctx.boss.getJobById(queue, jobId!)
    expect(job?.data).toStrictEqual({ hello: 'world' })
  })

  it('should rollback a job sent in a failed postgres-js drizzle transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = getDb()
    const queue = ctx.bossConfig.schema
    await ctx.boss.createQueue(queue)

    let jobId: string | null = null

    try {
      await db.transaction(async (tx) => {
        jobId = await ctx.boss!.send(queue, { hello: 'world' }, { db: fromDrizzle(tx, drizzleSql) })
        throw new Error('rollback')
      })
    } catch {}

    expect(jobId).toBeDefined()

    const job = await ctx.boss.getJobById(queue, jobId!)
    expect(job).toBeNull()
  })

  it('should handle empty result sets (postgres-js)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = getDb()

    const result = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      return adapter.executeSql('SELECT 1 as val WHERE false')
    })

    expect(result.rows).toStrictEqual([])
  })

  it('should handle array parameters bound to ANY($N::uuid[]) (postgres-js)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = getDb()

    const id = 'd1e48017-d11b-4434-a745-90ee6453caef'

    const result = await db.transaction(async (tx) => {
      const adapter = fromDrizzle(tx, drizzleSql)
      return adapter.executeSql(
        `SELECT $1::uuid = ANY($2::uuid[]) as single,
                ($1::uuid = ANY($3::uuid[])) as multi`,
        [id, [id], [id, 'a745d11b-d11b-4434-a745-90ee6453caef']]
      )
    })

    expect(result.rows[0]?.single).toBe(true)
    expect(result.rows[0]?.multi).toBe(true)
  })
})

describe('prisma adapter', () => {
  let prisma: PrismaClient
  let pool: pg.Pool

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    if (pool) await pool.end()
  })

  it('should execute sql through prisma transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    pool = new pg.Pool({ connectionString: connString })
    const adapter = new PrismaPg(pool)
    prisma = new PrismaClient({ adapter })

    const jobId = await prisma.$transaction(async (tx) => {
      const db = fromPrisma(tx)
      const result = await db.executeSql(
        `INSERT INTO ${ctx.schema}.job (name, data, state)
         VALUES ($1, $2, 'created')
         RETURNING id`,
        [ctx.schema, '{}']
      )
      return result.rows[0]?.id
    })

    expect(jobId).toBeDefined()
  })

  it('should execute parameterless sql through prisma transaction', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    if (!prisma) {
      const adapter = new PrismaPg(pool)
      prisma = new PrismaClient({ adapter })
    }

    const result = await prisma.$transaction(async (tx) => {
      const db = fromPrisma(tx)
      return db.executeSql('SELECT 1 as val')
    })

    expect(result.rows[0]?.val).toBe(1)
  })

  it('should rollback on prisma transaction failure', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    if (!prisma) {
      const adapter = new PrismaPg(pool)
      prisma = new PrismaClient({ adapter })
    }

    let jobId: string | undefined
    try {
      await prisma.$transaction(async (tx) => {
        const db = fromPrisma(tx)
        const result = await db.executeSql(
          `INSERT INTO ${ctx.schema}.job (name, data, state)
           VALUES ($1, $2, 'created')
           RETURNING id`,
          [ctx.schema, '{}']
        )
        jobId = result.rows[0]?.id
        throw new Error('force rollback')
      })
    } catch {}

    expect(jobId).toBeDefined()
    const check = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(check.rows.length).toBe(0)
  })

  it('should handle repeated parameter placeholders (prisma)', async () => {
    ctx.boss = await helper.start(ctx.bossConfig)
    if (!pool) pool = new pg.Pool({ connectionString: connString })
    if (!prisma) {
      const adapter = new PrismaPg(pool)
      prisma = new PrismaClient({ adapter })
    }

    const result = await prisma.$transaction(async (tx) => {
      const db = fromPrisma(tx)
      return db.executeSql(
        'SELECT $1::int as a, $2::int as b, $1::int as c',
        [7, 9]
      )
    })

    expect(result.rows[0]?.a).toBe(7)
    expect(result.rows[0]?.b).toBe(9)
    expect(result.rows[0]?.c).toBe(7)
  })
})
