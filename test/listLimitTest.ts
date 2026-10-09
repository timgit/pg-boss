import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as Attorney from '../src/attorney.ts'
import { PgBoss } from '../src/index.ts'

describe('list limits', function () {
  it('defaults a list read to 1000 rows and accepts 1 to 100000', function () {
    expect(Attorney.assertListLimit('getQueues')).toBe(1000)
    expect(Attorney.assertListLimit('getQueues', 1)).toBe(1)
    expect(Attorney.assertListLimit('getQueues', 100_000)).toBe(100_000)

    for (const limit of [0, 1.5, 100_001]) {
      expect(() => Attorney.assertListLimit('getQueues', limit)).toThrow('getQueues: limit must be an integer between 1 and 100000')
    }
  })

  it('getQueues() returns at most limit queues, by name', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(`${ctx.schema}_b`)
    await ctx.boss.createQueue(`${ctx.schema}_a`)

    expect((await ctx.boss.getQueues(undefined, { limit: 1 })).map(q => q.name)).toEqual([`${ctx.schema}_a`])
    await expect(ctx.boss.getQueues(undefined, { limit: 0 })).rejects.toThrow('getQueues: limit must be an integer between 1 and 100000')
  })

  it('getSchedules() returns at most limit schedules, with or without a name', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'b' })
    await ctx.boss.schedule(ctx.schema, '* * * * *', null, { key: 'a' })

    expect((await ctx.boss.getSchedules(undefined, undefined, { limit: 1 })).map(s => s.key)).toEqual(['a'])
    expect((await ctx.boss.getSchedules(ctx.schema, undefined, { limit: 1 })).map(s => s.key)).toEqual(['a'])
    expect(await ctx.boss.getSchedules(ctx.schema)).toHaveLength(2)
    await expect(ctx.boss.getSchedules(undefined, undefined, { limit: 100_001 })).rejects.toThrow('getSchedules: limit must be an integer between 1 and 100000')
  })

  it('getBlockedKeys() returns at most limit keys, in order', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo' })

    for (const key of ['key-b', 'key-a']) {
      await ctx.boss.send(ctx.schema, null, { singletonKey: key, retryLimit: 0 })
      const [job] = await ctx.boss.fetch(ctx.schema)
      await ctx.boss.fail(ctx.schema, job.id)
    }

    expect(await ctx.boss.getBlockedKeys(ctx.schema, { limit: 1 })).toEqual(['key-a'])
    await expect(ctx.boss.getBlockedKeys(ctx.schema, { limit: 0 })).rejects.toThrow('getBlockedKeys: limit must be an integer between 1 and 100000')
  })

  it('getDependencies() and getDependents() return at most limit jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'p1', name: ctx.schema },
      { ref: 'p2', name: ctx.schema },
      { ref: 'c1', name: ctx.schema, dependsOn: ['p1', 'p2'] },
      { ref: 'c2', name: ctx.schema, dependsOn: ['p1'] }
    ])

    const parents = await ctx.boss.getDependencies(ctx.schema, flow.c1, { limit: 1 })
    expect(parents).toEqual([{ name: ctx.schema, id: [flow.p1, flow.p2].sort()[0] }])

    const children = await ctx.boss.getDependents(ctx.schema, flow.p1, { limit: 1 })
    expect(children).toEqual([{ name: ctx.schema, id: [flow.c1, flow.c2].sort()[0] }])

    await expect(ctx.boss.getDependents(ctx.schema, flow.p1, { limit: 1.5 })).rejects.toThrow('getDependents: limit must be an integer between 1 and 100000')
  })

  it('getInstances() returns at most limit instances, oldest first', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, schedule: false })
    const second = new PgBoss({ ...ctx.bossConfig, supervise: false, schedule: false, migrate: false, instanceName: 'second' })
    await second.start()

    try {
      expect(await ctx.boss.getInstances()).toHaveLength(2)

      const oldest = await ctx.boss.getInstances({ limit: 1 })
      expect(oldest).toHaveLength(1)
      expect(oldest[0].name).not.toBe('second')
    } finally {
      await second.stop({ graceful: false })
    }

    await expect(ctx.boss.getInstances({ limit: 0 })).rejects.toThrow('getInstances: limit must be an integer between 1 and 100000')
  })

  it('getBamEntries() returns at most limit entries', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    expect((await ctx.boss.getBamEntries({ limit: 1 })).length).toBeLessThanOrEqual(1)
    await expect(ctx.boss.getBamEntries({ limit: 0 })).rejects.toThrow('getBamEntries: limit must be an integer between 1 and 100000')
  })
})
