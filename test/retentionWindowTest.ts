import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { TestClock } from '../src/index.ts'
import { ctx } from './hooks.ts'

// A job's retention window is keep_until - start_after. Whatever moves start_after moves keep_until by
// the same number of seconds. A session in a time zone with DST would otherwise add the window as
// calendar days, which come out an hour short across the March change.
// Skipped on PGlite, which takes no connection options to set the session time zone with.
describe('retention window', function () {
  const retentionSeconds = 7 * 24 * 60 * 60

  // 2027-03-14 is the spring-forward day in New York, so every window here crosses it.
  async function start () {
    const clock = new TestClock('2027-03-10T12:00:00Z')
    const boss = await helper.start({ ...ctx.bossConfig, clock, options: '-c TimeZone=America/New_York' })
    ctx.boss = boss
    return { boss, clock }
  }

  async function windowSeconds (id: string) {
    const { rows: [row] } = await helper.findJobs(ctx.schema, 'id = $1', [id])
    return (new Date(row.keep_until).getTime() - new Date(row.start_after).getTime()) / 1000
  }

  helper.itPglite('keeps the window when a failure schedules a retry', async function () {
    const { boss } = await start()
    const id = await boss.send(ctx.schema, null, { retentionSeconds, retryLimit: 1, retryDelay: 60 })
    assertTruthy(id)

    await boss.fetch(ctx.schema)
    await boss.fail(ctx.schema, id)

    expect(await windowSeconds(id)).toBe(retentionSeconds)
  })

  helper.itPglite('keeps the window when retry() moves start_after', async function () {
    const { boss, clock } = await start()
    const id = await boss.send(ctx.schema, null, { retentionSeconds, retryLimit: 0 })
    assertTruthy(id)

    await boss.fetch(ctx.schema)
    await boss.fail(ctx.schema, id)
    await clock.tick(60_000)
    await boss.retry(ctx.schema, id)

    expect(await windowSeconds(id)).toBe(retentionSeconds)
  })

  helper.itPglite('keeps the window when resume() moves start_after', async function () {
    const { boss, clock } = await start()
    const id = await boss.send(ctx.schema, null, { retentionSeconds })
    assertTruthy(id)

    await boss.cancel(ctx.schema, id)
    await clock.tick(60_000)
    await boss.resume(ctx.schema, id)

    expect(await windowSeconds(id)).toBe(retentionSeconds)
  })

  helper.itPglite('keeps the window when update() moves start_after', async function () {
    const { boss } = await start()
    const id = await boss.send(ctx.schema, null, { retentionSeconds })
    assertTruthy(id)

    await boss.update(ctx.schema, undefined, { id, startAfter: 120 })

    expect(await windowSeconds(id)).toBe(retentionSeconds)
  })
})
