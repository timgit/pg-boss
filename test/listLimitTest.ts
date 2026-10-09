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

describe('list paging', function () {
  // Reads a list a page at a time, each page continuing after the last row of the one before.
  async function pageAll<T, A> (read: (after?: A) => Promise<T[]>, next: (row: T) => A): Promise<T[]> {
    const rows: T[] = []
    let after: A | undefined
    for (;;) {
      const page = await read(after)
      if (page.length === 0) return rows
      rows.push(...page)
      after = next(page.at(-1)!)
    }
  }

  it('findJobs() pages through jobs that share a created_on without repeating or skipping one', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // One insert() is one transaction, so its five jobs share a created_on.
    await ctx.boss.insert(ctx.schema, [1, 2, 3, 4, 5].map(i => ({ data: { i } })))
    await ctx.boss.send(ctx.schema, { i: 6 })
    await ctx.boss.send(ctx.schema, { i: 7 })

    const all = await ctx.boss.findJobs(ctx.schema)
    const paged = await pageAll((after?: string) => ctx.boss!.findJobs(ctx.schema, { limit: 2, after }), job => job.id)

    expect(paged.map(job => job.id)).toEqual(all.map(job => job.id))
    expect(new Set(paged.map(job => job.id)).size).toBe(7)
  })

  it('findJobs() rejects an after whose job was deleted, and ends quietly after the last one', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const first = await ctx.boss.send(ctx.schema)
    const last = await ctx.boss.send(ctx.schema)

    expect(await ctx.boss.findJobs(ctx.schema, { after: last! })).toEqual([])

    await ctx.boss.deleteJob(ctx.schema, last!)
    await expect(ctx.boss.findJobs(ctx.schema, { after: last! })).rejects.toThrow('findJobs: after names a row that no longer exists')
    expect((await ctx.boss.findJobs(ctx.schema, { after: first! })).length).toBe(0)
  })

  it('getQueues(), getSchedules() and getBlockedKeys() page in their order', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const names = ['c', 'a', 'b'].map(suffix => `${ctx.schema}_${suffix}`)
    for (const name of names) await ctx.boss.createQueue(name)
    const sorted = [...names].sort()

    expect((await pageAll((after?: string) => ctx.boss!.getQueues(undefined, { limit: 1, after }), q => q.name)).map(q => q.name)).toEqual(sorted)

    for (const key of ['k2', 'k1', 'k3']) await ctx.boss.schedule(sorted[0], '* * * * *', null, { key })
    await ctx.boss.schedule(sorted[1], '* * * * *', null, { key: 'k1' })

    const every = await pageAll((after?: { name: string, key: string }) => ctx.boss!.getSchedules(undefined, undefined, { limit: 1, after }), s => s)
    expect(every.map(s => `${s.name}/${s.key}`)).toEqual([`${sorted[0]}/k1`, `${sorted[0]}/k2`, `${sorted[0]}/k3`, `${sorted[1]}/k1`])

    const one = await pageAll((after?: { name: string, key: string }) => ctx.boss!.getSchedules(sorted[0], undefined, { limit: 2, after }), s => s)
    expect(one.map(s => s.key)).toEqual(['k1', 'k2', 'k3'])

    const fifo = `${ctx.schema}_fifo`
    await ctx.boss.createQueue(fifo, { policy: 'key_strict_fifo' })
    for (const key of ['key-c', 'key-a', 'key-b']) {
      await ctx.boss.send(fifo, null, { singletonKey: key, retryLimit: 0 })
      const [job] = await ctx.boss.fetch(fifo)
      await ctx.boss.fail(fifo, job.id)
    }
    expect(await pageAll((after?: string) => ctx.boss!.getBlockedKeys(fifo, { limit: 1, after }), key => key)).toEqual(['key-a', 'key-b', 'key-c'])
  })

  it('getDependencies() and getDependents() page by queue name and id', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const flow = await ctx.boss.flow([
      { ref: 'p1', name: ctx.schema },
      { ref: 'p2', name: ctx.schema },
      { ref: 'p3', name: ctx.schema },
      { ref: 'c', name: ctx.schema, dependsOn: ['p1', 'p2', 'p3'] }
    ])

    const parents = await pageAll((after?: { name: string, id: string }) => ctx.boss!.getDependencies(ctx.schema, flow.c, { limit: 1, after }), ref => ref)
    expect(parents.map(ref => ref.id)).toEqual([flow.p1, flow.p2, flow.p3].sort())

    await expect(ctx.boss.getDependents(ctx.schema, flow.p1, { after: { name: ctx.schema } as any })).rejects.toThrow('getDependents: after must be an object with string name and id')
  })

  it('getInstances() and getBamEntries() page by id, and reject an id that names nothing', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, schedule: false })
    const second = new PgBoss({ ...ctx.bossConfig, supervise: false, schedule: false, migrate: false, instanceName: 'second' })
    await second.start()

    try {
      const all = await ctx.boss.getInstances()
      const paged = await pageAll((after?: string) => ctx.boss!.getInstances({ limit: 1, after }), instance => instance.id)
      expect(paged.map(instance => instance.id)).toEqual(all.map(instance => instance.id))
    } finally {
      await second.stop({ graceful: false })
    }

    const missing = '00000000-0000-4000-8000-000000000000'
    await expect(ctx.boss.getInstances({ after: missing })).rejects.toThrow('getInstances: after names a row that no longer exists')
    await expect(ctx.boss.getBamEntries({ after: missing })).rejects.toThrow('getBamEntries: after names a row that no longer exists')
    await expect(ctx.boss.getQueues(undefined, { after: '' })).rejects.toThrow('getQueues: after must be a non-empty string')
  })
})
