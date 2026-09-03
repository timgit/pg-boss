import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import Timekeeper from '../src/timekeeper.ts'
import { ctx } from './hooks.ts'

describe('getSchedule', function () {
  it('should return a single schedule by queue name and key', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'a' })

    const schedule = await ctx.boss.getSchedule(ctx.schema, 'a')

    helper.assertTruthy(schedule)
    expect(schedule.name).toBe(ctx.schema)
    expect(schedule.key).toBe('a')
    expect(schedule.cron).toBe('0 1 * * *')
  })

  it('should return the default-key schedule when no key is given', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *')
    await ctx.boss.schedule(ctx.schema, '0 1 * * *', null, { key: 'a' })

    const schedule = await ctx.boss.getSchedule(ctx.schema)

    helper.assertTruthy(schedule)
    expect(schedule.key).toBe('')
    expect(schedule.cron).toBe('* * * * *')
  })

  it('should return null when the schedule does not exist', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    expect(await ctx.boss.getSchedule(ctx.schema, 'nope')).toBeNull()
  })

  it('should reject a missing queue name', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await expect(async () => {
      // @ts-expect-error deliberately calling without the required queue name
      await ctx.boss.getSchedule()
    }).rejects.toThrow()
  })
})

// Pure computation: no database, no running instance.
describe('previewSchedule', function () {
  function makeTk (config: object = {}) {
    const db = { executeSql: async () => ({ rows: [] }) }
    return new Timekeeper(db as any, {} as any, { schema: 'test', ...config } as any)
  }

  it('should return the next occurrences after the reference date', function () {
    const tk = makeTk()

    const occurrences = tk.previewSchedule('0 3 * * *', { from: new Date('2026-03-01T00:00:00Z'), count: 3 })

    expect(occurrences.map(d => d.toISOString())).toEqual([
      '2026-03-01T03:00:00.000Z',
      '2026-03-02T03:00:00.000Z',
      '2026-03-03T03:00:00.000Z'
    ])
  })

  it('should evaluate the expression in the supplied time zone', function () {
    const tk = makeTk()

    const [first] = tk.previewSchedule('0 3 * * *', {
      tz: 'America/Chicago',
      from: new Date('2026-03-01T00:00:00Z'),
      count: 1
    })

    // 3am US central on March 1 is still standard time (UTC-6)
    expect(first.toISOString()).toBe('2026-03-01T09:00:00.000Z')
  })

  it('should default to five occurrences', function () {
    const tk = makeTk()

    expect(tk.previewSchedule('* * * * *').length).toBe(5)
  })

  it('should exclude the reference date itself so pages do not overlap', function () {
    const tk = makeTk()

    const from = new Date('2026-03-01T03:00:00Z')
    const [first] = tk.previewSchedule('0 3 * * *', { from, count: 1 })

    expect(first.toISOString()).toBe('2026-03-02T03:00:00.000Z')

    // handing the last occurrence back in yields the next page
    const [next] = tk.previewSchedule('0 3 * * *', { from: first, count: 1 })
    expect(next.toISOString()).toBe('2026-03-03T03:00:00.000Z')
  })

  it('should start from database time when no reference date is given', function () {
    const tk = makeTk()

    // an hour of clock skew has to move the first occurrence of an hourly expression
    tk.clockSkew = 60 * 60 * 1000

    const [skewed] = tk.previewSchedule('0 * * * *', { count: 1 })

    tk.clockSkew = 0

    const [local] = tk.previewSchedule('0 * * * *', { count: 1 })

    expect(skewed.getTime()).toBeGreaterThan(local.getTime())
  })

  it('should reject an expression schedule() would reject', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('bogus')).toThrow()
  })

  it('should reject an unusable time zone', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('* * * * *', { tz: 'Mars/Phobos' })).toThrow(/time zone/)
  })

  it('should reject a count outside the supported range', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('* * * * *', { count: 0 })).toThrow(/count/)
    expect(() => tk.previewSchedule('* * * * *', { count: 1001 })).toThrow(/count/)
    expect(() => tk.previewSchedule('* * * * *', { count: 1.5 })).toThrow(/count/)
  })

  it('should reject an invalid reference date', function () {
    const tk = makeTk()

    expect(() => tk.previewSchedule('* * * * *', { from: new Date('nope') })).toThrow(/from/)
  })

  it('should agree with the expression a schedule was stored with', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *', null, { key: 'daily', tz: 'America/Chicago' })

    const schedule = await ctx.boss.getSchedule(ctx.schema, 'daily')

    helper.assertTruthy(schedule)

    const occurrences = ctx.boss.previewSchedule(schedule.cron, {
      tz: schedule.timezone,
      from: new Date('2026-03-01T00:00:00Z'),
      count: 2
    })

    expect(occurrences.map(d => d.toISOString())).toEqual([
      '2026-03-01T09:00:00.000Z',
      '2026-03-02T09:00:00.000Z'
    ])
  })
})
