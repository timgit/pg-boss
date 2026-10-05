import { expect } from 'vitest'
import pg from 'pg'
import * as helper from './testHelper.ts'
import { TestClock } from '../src/index.ts'
import { ctx } from './hooks.ts'

// Runs `fn` with a database adapter bound to one open transaction, then ends the transaction the way
// the caller asks, which is how a rolled-back write is told apart from a committed one.
async function inTransaction (outcome: 'COMMIT' | 'ROLLBACK', fn: (db: { executeSql: (sql: string, values?: any[]) => Promise<any> }) => Promise<void>) {
  const client = new pg.Client({ connectionString: helper.getConnectionString() })
  await client.connect()

  try {
    await client.query('BEGIN')
    await fn({ executeSql: (sql, values) => client.query(sql, values) })
    await client.query(outcome)
  } finally {
    await client.end()
  }
}

describe('schedule with a database adapter', function () {
  it('should not store the db option on the schedule row', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql: string, values: any[]) {
        called = true
        return _db.executeSql(sql, values)
      }
    }

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { db, tz: 'UTC', key: 'a' })
    const [schedule] = await ctx.boss.getSchedules(ctx.schema, 'a')
    await _db.close()

    expect(called).toBe(true)
    expect(schedule.options).toEqual({ tz: 'UTC', key: 'a' })
  })

  it('should send the scheduled job when the schedule was created with a db option', async function () {
    const config = {
      ...ctx.bossConfig,
      clock: new TestClock(),
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    const _db = await helper.getDb()
    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { db: _db })
    await _db.close()

    for (let i = 0; i < 20; i++) {
      await config.clock.tick(1000)
      if ((await helper.countJobs(ctx.schema, 'job', 'name = $1', [ctx.schema])) >= 1) break
    }

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeTruthy()
  })

  // Rows written before db was kept out of the stored options carry it as {}; the cron pass must not
  // hand that to send() as an adapter.
  it('should send the scheduled job from a row stored with a db option', async function () {
    const config = {
      ...ctx.bossConfig,
      clock: new TestClock(),
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)
    const errors: Error[] = []
    ctx.boss.on('error', error => errors.push(error))

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${ctx.schema}.schedule SET options = '{"db":{}}'::jsonb`)
    await db.close()

    for (let i = 0; i < 20; i++) {
      await config.clock.tick(1000)
      if ((await helper.countJobs(ctx.schema, 'job', 'name = $1', [ctx.schema])) >= 1) break
    }

    expect(await helper.countJobs(ctx.schema, 'job', 'name = $1', [ctx.schema])).toBe(1)
    expect(errors).toEqual([])
  })

  helper.itPglite('should not create a schedule when its transaction is rolled back', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await inTransaction('ROLLBACK', async (db) => {
      await ctx.boss!.schedule(ctx.schema, '* * * * *', null, { db })
    })

    expect(await ctx.boss.getSchedules(ctx.schema)).toEqual([])
  })

  helper.itPglite('should create a schedule when its transaction is committed', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await inTransaction('COMMIT', async (db) => {
      await ctx.boss!.schedule(ctx.schema, '* * * * *', null, { db })
    })

    const schedules = await ctx.boss.getSchedules(ctx.schema)

    expect(schedules.length).toBe(1)
    expect(schedules[0].options).toEqual({})
  })
})

describe('unschedule with a database adapter', function () {
  helper.itPglite('should keep the schedule when its transaction is rolled back', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    await inTransaction('ROLLBACK', async (db) => {
      await ctx.boss!.unschedule(ctx.schema, undefined, { db })
    })

    expect((await ctx.boss.getSchedules(ctx.schema)).length).toBe(1)
  })

  helper.itPglite('should remove the schedule when its transaction is committed', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })

    await inTransaction('COMMIT', async (db) => {
      await ctx.boss!.unschedule(ctx.schema, 'a', { db })
    })

    expect(await ctx.boss.getSchedules(ctx.schema)).toEqual([])
  })
})
