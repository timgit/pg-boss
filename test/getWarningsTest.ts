import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('getWarnings', function () {
  // Four warnings: two that share a created_on, one older and one newer.
  async function seed () {
    const db = await helper.getDb()
    try {
      await db.executeSql(`
        INSERT INTO ${ctx.schema}.warning (type, message, data, created_on)
        VALUES ('slow_query', 'oldest', '{"n":1}', now() - interval '3 hours'),
               ('queue_backlog', 'tied', '{"n":2}', now() - interval '2 hours'),
               ('slow_query', 'tied', '{"n":3}', now() - interval '2 hours'),
               ('slow_query', 'newest', '{"n":4}', now() - interval '1 hour')
      `)
    } finally {
      await db.close()
    }
  }

  it('returns warnings newest first, and filters by type', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, schedule: false })
    await seed()

    const all = await ctx.boss.getWarnings()
    expect(all.map(w => w.message)).toEqual(['newest', 'tied', 'tied', 'oldest'])
    expect(all[0]).toMatchObject({ type: 'slow_query', data: { n: 4 } })
    expect(all[0].createdOn).toBeInstanceOf(Date)
    expect(typeof all[0].id).toBe('string')

    const slow = await ctx.boss.getWarnings({ type: 'slow_query' })
    expect(slow.map(w => w.data)).toEqual([{ n: 4 }, { n: 3 }, { n: 1 }])

    expect(await ctx.boss.getWarnings({ type: 'clock_skew' })).toEqual([])
    expect((await ctx.boss.getWarnings({ limit: 2 })).length).toBe(2)
  })

  it('pages by id through warnings that share a created_on, with or without a type', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, schedule: false })
    await seed()

    for (const type of [undefined, 'slow_query' as const]) {
      const all = await ctx.boss.getWarnings({ type })
      const paged = []
      let after: string | undefined
      for (;;) {
        const page = await ctx.boss.getWarnings({ type, limit: 1, after })
        if (page.length === 0) break
        paged.push(...page)
        after = page.at(-1)!.id
      }
      expect(paged.map(w => w.id)).toEqual(all.map(w => w.id))
    }
  })

  it('rejects an invalid limit, type or after, and an after that names nothing', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, schedule: false })

    await expect(ctx.boss.getWarnings({ limit: 0 })).rejects.toThrow('getWarnings: limit must be an integer between 1 and 100000')
    await expect(ctx.boss.getWarnings({ after: 'not-a-uuid' })).rejects.toThrow('getWarnings: after must be a uuid')
    // @ts-expect-error type is a WarningType
    await expect(ctx.boss.getWarnings({ type: '' })).rejects.toThrow('getWarnings: type must be a non-empty string')
    await expect(ctx.boss.getWarnings({ after: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow('getWarnings: after names a row that no longer exists')
  })

  it('returns a warning that monitoring persisted', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, persistWarnings: true, __test__warn_slow_query: true })
    await ctx.boss.supervise(ctx.schema)

    const [warning] = await ctx.boss.getWarnings({ type: 'slow_query', limit: 1 })
    expect(warning.message).toContain('slow query')
    expect(warning.data).toHaveProperty('elapsed')
  })
})
