import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('delayed jobs', function () {
  it('should wait until after an int (in seconds)', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const startAfter = 2

    await ctx.boss.send(ctx.schema, null, { startAfter })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(startAfter * 1000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should wait until after a date time string', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const date = new Date()

    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date.toISOString()

    await ctx.boss.send(ctx.schema, null, { startAfter })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(5000)

    const job2 = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should wait until after a date object', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await ctx.boss.send(ctx.schema, null, { startAfter })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(2000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  it('should work with sendAfter() and a date object', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await ctx.boss.sendAfter(ctx.schema, { something: 1 }, { retryLimit: 0 }, startAfter)

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()

    await delay(2000)

    const [job2] = await ctx.boss.fetch(ctx.schema)

    expect(job2).toBeTruthy()
  })

  // The instant 2027-01-01T08:00:00Z, written in each of the ISO 8601 zone designators.
  // Only the 'Z' spelling used to be recognized as a date; the rest fell through to an
  // interval cast and threw 'invalid input syntax for type interval'.
  const INSTANT = '2027-01-01T08:00:00.000Z'
  const zoned = [
    ['Z', '2027-01-01T08:00:00Z'],
    ['a zero UTC offset', '2027-01-01T08:00:00+00:00'],
    ['a positive offset', '2027-01-01T13:30:00+05:30'],
    ['a negative offset', '2027-01-01T00:00:00-08:00']
  ] as const

  for (const [label, startAfter] of zoned) {
    it(`should resolve a date time string with ${label} to the same instant`, async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const id = await ctx.boss.send(ctx.schema, null, { startAfter })
      assertTruthy(id)

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)
      expect(new Date(job.startAfter).toISOString()).toBe(INSTANT)
    })
  }

  it('should resolve a date time string with an offset passed to sendAfter()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const id = await ctx.boss.sendAfter(ctx.schema, { something: 1 }, {}, '2027-01-01T13:30:00+05:30')
    assertTruthy(id)

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)
    expect(new Date(job.startAfter).toISOString()).toBe(INSTANT)
  })

  // A string with no zone designator is resolved by Postgres in the database's time zone, so
  // the exact instant depends on that setting. Asserting within a day of the nominal UTC
  // instant keeps this independent of the server's time zone (max offset is ±14h) while still
  // proving the string parsed as a date time rather than being rejected as an interval.
  const ONE_DAY = 24 * 60 * 60 * 1000
  for (const [label, startAfter, nominal] of [
    ['a date time string with no zone', '2027-01-01T08:00:00', '2027-01-01T08:00:00Z'],
    ['a space-separated date time string', '2027-01-01 08:00:00', '2027-01-01T08:00:00Z'],
    ['a date-only string', '2027-01-01', '2027-01-01T00:00:00Z']
  ] as const) {
    it(`should accept ${label}`, async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const id = await ctx.boss.send(ctx.schema, null, { startAfter })
      assertTruthy(id)

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)

      const drift = Math.abs(new Date(job.startAfter).getTime() - new Date(nominal).getTime())
      expect(drift).toBeLessThanOrEqual(ONE_DAY)
    })
  }

  // Forms that reached the date time path only via the trailing 'Z' check, so they keep
  // working: ISO 8601 basic format, and a value with leading whitespace.
  for (const [label, startAfter] of [
    ['in ISO 8601 basic format', '20270101T080000Z'],
    ['with leading whitespace', '  2027-01-01T08:00:00Z']
  ] as const) {
    it(`should still resolve a date time string ${label}`, async function () {
      ctx.boss = await helper.start(ctx.bossConfig)

      const id = await ctx.boss.send(ctx.schema, null, { startAfter })
      assertTruthy(id)

      const job = await ctx.boss.getJobById(ctx.schema, id)
      assertTruthy(job)
      expect(new Date(job.startAfter).toISOString()).toBe(INSTANT)
    })
  }

  // Relative interval strings must keep taking the interval path.
  it('should still accept a relative interval string', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const before = Date.now()
    const id = await ctx.boss.send(ctx.schema, null, { startAfter: '1 hour' })
    assertTruthy(id)

    const job = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(job)

    const startAfterMs = new Date(job.startAfter).getTime()
    expect(startAfterMs).toBeGreaterThan(before + 59 * 60 * 1000)
    expect(startAfterMs).toBeLessThan(before + 61 * 60 * 1000)
  })
})
