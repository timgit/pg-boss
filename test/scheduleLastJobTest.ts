import { delay } from '../src/tools.ts'
import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import Timekeeper from '../src/timekeeper.ts'
import { ctx } from './hooks.ts'

describe('schedule lastJobId', function () {
  it('should be null on a schedule that has not fired', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *')

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.lastJobId).toBeNull()
  })

  it('should record the job the schedule created', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    await delay(4000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    helper.assertTruthy(job)

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.lastJobId).toBe(job.id)
  })

  it('should record each key independently', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *', { region: 'us' }, { key: 'us' })
    await ctx.boss.schedule(ctx.schema, '* * * * *', { region: 'eu' }, { key: 'eu' })

    await delay(4000)

    const jobs = await ctx.boss.fetch<{ region: string }>(ctx.schema, { batchSize: 2 })

    expect(jobs.length).toBe(2)

    const schedules = await ctx.boss.getSchedules()
    const byKey = Object.fromEntries(schedules.map(s => [s.key, s.lastJobId]))
    const byRegion = Object.fromEntries(jobs.map(j => [j.data.region, j.id]))

    expect(byKey.us).toBe(byRegion.us)
    expect(byKey.eu).toBe(byRegion.eu)
    expect(byKey.us).not.toBe(byKey.eu)
  })

  it('should be readable through getSchedules by queue and key', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })

    await delay(4000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    helper.assertTruthy(job)

    const [schedule] = await ctx.boss.getSchedules(ctx.schema, 'a')

    expect(schedule.lastJobId).toBe(job.id)
  })

  it('should survive a schedule update', async function () {
    const config = {
      ...ctx.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    ctx.boss = await helper.start(config)

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    await delay(4000)

    const [job] = await ctx.boss.fetch(ctx.schema)

    helper.assertTruthy(job)

    // re-scheduling is an upsert of the definition, not a reset of the run history
    await ctx.boss.schedule(ctx.schema, '0 3 * * *')

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.cron).toBe('0 3 * * *')
    expect(schedule.lastJobId).toBe(job.id)
  })

  it('should expose createdOn and updatedOn in camelCase', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *')

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.createdOn).toBeInstanceOf(Date)
    expect(schedule.updatedOn).toBeInstanceOf(Date)
  })
})

// Pure unit tests for the send-it handler's bookkeeping, with no database behind it.
describe('schedule lastJobId bookkeeping', function () {
  function makeTk (sent: (string | null)[]) {
    const executed: { sql: string, values?: unknown[] }[] = []
    const db = {
      executeSql: async (sql: string, values?: unknown[]) => {
        executed.push({ sql, values })
        return { rows: [] }
      }
    }
    let index = 0
    const manager = { send: async () => sent[index++] ?? null }
    const tk = new Timekeeper(db as any, manager as any, { schema: 'test' } as any)
    return { tk, executed }
  }

  it('should skip a payload written before the key was carried', async function () {
    const { tk, executed } = makeTk(['00000000-0000-0000-0000-000000000001'])

    // a 12.29.0 instance wrote this occurrence: no key to attribute the job to
    await (tk as any).onSendIt([{ data: { name: 'q', data: null, options: {} } }])

    expect(executed.length).toBe(0)
  })

  it('should skip an occurrence a queue policy dropped', async function () {
    const { tk, executed } = makeTk([null])

    await (tk as any).onSendIt([{ data: { name: 'q', key: '', data: null, options: {} } }])

    expect(executed.length).toBe(0)
  })

  it('should record a whole batch in one statement', async function () {
    const ids = [
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003'
    ]
    const { tk, executed } = makeTk(ids)

    await (tk as any).onSendIt([
      { data: { name: 'q', key: 'a', data: null, options: {} } },
      { data: { name: 'q', key: 'b', data: null, options: {} } },
      { data: { name: 'r', key: '', data: null, options: {} } }
    ])

    expect(executed.length).toBe(1)
    expect(JSON.parse(executed[0].values![0] as string)).toEqual([
      { name: 'q', key: 'a', job_id: ids[0] },
      { name: 'q', key: 'b', job_id: ids[1] },
      { name: 'r', key: '', job_id: ids[2] }
    ])
  })

  it('should report a failed annotation without failing the send-it job', async function () {
    const { tk } = makeTk(['00000000-0000-0000-0000-000000000001'])

    ;(tk as any).db.executeSql = async () => { throw new Error('boom') }

    const errors: any[] = []
    tk.on('error', err => errors.push(err))

    await (tk as any).onSendIt([{ data: { name: 'q', key: '', data: null, options: {} } }])

    expect(errors.length).toBe(1)
    expect(errors[0].message).toBe('boom')
  })
})
