import { describe, it, afterAll } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import pg from 'pg'

import { fromKnex, fromKysely, fromDrizzle, fromPrisma } from '../src/adapters/index.ts'

import knex, { type Knex } from 'knex'
import { Kysely, PostgresDialect } from 'kysely'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql as drizzleSql } from 'drizzle-orm'
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
})
