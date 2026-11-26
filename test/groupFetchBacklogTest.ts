import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { TestClock } from '../src/index.ts'
import type { PgBoss } from '../src/index.ts'

// A fetch with a group option reads at most 500 waiting jobs before it filters by group. A skipped
// group needs a deeper backlog than that to push other groups past the first step.
const BACKLOG = 600

// Claims `active` jobs of `busy` so it is at its limit, then queues its backlog ahead of everything
// the test adds next. Each job gets its own singleton key, which every policy accepts. The fetch
// after it finds nothing and runs the full scan. The next short fetch within a minute then takes the
// hop.
async function seedBusyGroup (boss: PgBoss, name: string, clock: TestClock, active = 1, tier?: string) {
  const group = tier ? { id: 'busy', tier } : { id: 'busy' }

  await boss.insert(name, Array.from({ length: active }, (_, i) => ({ data: { id: 'busy' }, singletonKey: `busy-active-${i}`, group })))
  expect(await boss.fetch(name, { batchSize: active, groupConcurrency: active })).toHaveLength(active)

  await clock.tick(1000)
  await boss.insert(name, Array.from({ length: BACKLOG }, (_, i) => ({ data: { id: 'busy' }, singletonKey: `busy-${i}`, group })))
  await clock.tick(1000)

  expect(await boss.fetch(name, { batchSize: 5, groupConcurrency: active })).toHaveLength(0)
}

async function insertGroups (boss: PgBoss, name: string, clock: TestClock, groups: string[], perGroup = 1, tier?: string) {
  await boss.insert(name, groups.flatMap(id =>
    Array.from({ length: perGroup }, (_, i) => ({ data: { id }, singletonKey: `${id}-${i}`, group: tier ? { id, tier } : { id } }))))
  await clock.tick(1000)
}

// Records which fetch statements run: 'window' (step one), 'hop', or 'scan' (today's full fetch).
// `fail` makes the named one throw.
function watchFetches (boss: PgBoss, fail?: 'hop') {
  const db = boss.getDb()
  const executeSql = db.executeSql
  const ran: string[] = []

  // Under a TestClock the db is a proxy. An assignment replaces its tracked method. A spy would land
  // on the db behind the proxy and call itself.
  db.executeSql = function (text: string, values?: unknown[]) {
    const kind = text.includes('hop_after') ? 'hop' : text.includes('window_status') ? 'window' : /^\s*WITH[\s\S]*UPDATE[\s\S]*SET\s+state = 'active'/.test(text) ? 'scan' : null

    if (kind) ran.push(kind)
    if (kind && kind === fail) throw new Error('hop refused')

    return executeSql.call(db, text, values)
  }

  return ran
}

const groupsOf = (jobs: { groupId?: string | null }[]) => jobs.map(job => job.groupId ?? null).sort()
const idsOf = (jobs: { data: unknown }[]) => jobs.map(job => (job.data as { id: string }).id).sort()

describe('group fetch behind a skipped group backlog', function () {
  for (const policy of ['standard', 'short', 'singleton', 'stately', 'exclusive']) {
    it(`claims other groups through the hop on a ${policy} queue`, async function () {
      const clock = new TestClock()
      ctx.boss = await helper.start({ ...ctx.bossConfig, clock, noDefault: true })
      await ctx.boss.createQueue(ctx.schema, { policy })

      await seedBusyGroup(ctx.boss, ctx.schema, clock)
      await insertGroups(ctx.boss, ctx.schema, clock, ['a', 'b', 'c'])

      const ran = watchFetches(ctx.boss)
      const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 })

      expect(groupsOf(jobs)).toEqual(['a', 'b', 'c'])
      expect(ran).toEqual(['window', 'hop'])
    })
  }

  it('claims through the hop on a partitioned queue', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { partition: true })

    await seedBusyGroup(ctx.boss, ctx.schema, clock)
    await insertGroups(ctx.boss, ctx.schema, clock, ['a', 'b'])

    const ran = watchFetches(ctx.boss)
    expect(groupsOf(await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 }))).toEqual(['a', 'b'])
    expect(ran).toEqual(['window', 'hop'])
  })

  it('claims each group up to the limit of its first waiting job\'s tier', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })
    const groupConcurrency = { default: 1, tiers: { pro: 3 } }

    // busy holds 3 active pro jobs, the highest limit. The hop passes over it.
    await seedBusyGroup(ctx.boss, ctx.schema, clock, 3, 'pro')
    await insertGroups(ctx.boss, ctx.schema, clock, ['basic'], 3)
    await insertGroups(ctx.boss, ctx.schema, clock, ['pro'], 4, 'pro')

    const ran = watchFetches(ctx.boss)
    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 10, groupConcurrency })

    expect(groupsOf(jobs)).toEqual(['basic', 'pro', 'pro', 'pro'])
    expect(ran).toEqual(['window', 'hop'])
  })

  it('applies the priority range and start_after in the hop', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await seedBusyGroup(ctx.boss, ctx.schema, clock)

    // maxPriority 0 keeps the high jobs out of the window, and the rest sit behind the backlog. Group
    // a's first job by order is the high one, then the deferred one. Only the hop's own conditions
    // get it to a-ready.
    await ctx.boss.insert(ctx.schema, [
      { data: { id: 'a-high' }, priority: 1, group: { id: 'a' } },
      { data: { id: 'a-deferred' }, startAfter: new Date(clock.now() + 60_000), group: { id: 'a' } },
      { data: { id: 'b-high' }, priority: 1, group: { id: 'b' } }
    ])
    await clock.tick(1000)
    await ctx.boss.insert(ctx.schema, [{ data: { id: 'a-ready' }, group: { id: 'a' } }, { data: { id: 'c-ready' }, group: { id: 'c' } }])
    await clock.tick(1000)

    const ran = watchFetches(ctx.boss)
    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1, maxPriority: 0 })

    expect(idsOf(jobs)).toEqual(['a-ready', 'c-ready'])
    expect(ran).toEqual(['window', 'hop'])
  })

  it('passes over a group head whose singleton key is busy', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { policy: 'singleton' })

    await ctx.boss.insert(ctx.schema, [{ data: { id: 'k-active' }, singletonKey: 'k' }])
    expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(1)

    await seedBusyGroup(ctx.boss, ctx.schema, clock)
    await ctx.boss.insert(ctx.schema, [{ data: { id: 'a-k' }, singletonKey: 'k', group: { id: 'a' } }])
    await clock.tick(1000)
    await ctx.boss.insert(ctx.schema, [{ data: { id: 'a-free' }, singletonKey: 'free', group: { id: 'a' } }])
    await clock.tick(1000)

    const ran = watchFetches(ctx.boss)
    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 })

    expect(idsOf(jobs)).toEqual(['a-free'])
    expect(ran).toEqual(['window', 'hop'])
  })

  it('reaches every group within groups / 50 hops by rotating where each hop starts', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await seedBusyGroup(ctx.boss, ctx.schema, clock)

    // Two jobs per group keep a claimed group in job_i18. A hop without rotation would visit the same
    // 50 groups again, find them all at their limit, and claim nothing.
    const groups = Array.from({ length: 120 }, (_, i) => `g${String(i).padStart(3, '0')}`)
    await insertGroups(ctx.boss, ctx.schema, clock, groups, 2)

    const ran = watchFetches(ctx.boss)
    const claimed: string[] = []

    for (let hop = 0; hop < 3; hop++) {
      claimed.push(...groupsOf(await ctx.boss.fetch(ctx.schema, { batchSize: 50, groupConcurrency: 1 })) as string[])
    }

    expect(claimed.sort()).toEqual(groups)
    expect(ran).toEqual(['window', 'hop', 'window', 'hop', 'window', 'hop'])
  })

  it('claims an ungrouped job past the window with the full scan once a minute', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await seedBusyGroup(ctx.boss, ctx.schema, clock)
    await ctx.boss.insert(ctx.schema, [{ data: { id: 'ungrouped' } }, { data: { id: 'a' }, group: { id: 'a' } }])
    await clock.tick(1000)

    const ran = watchFetches(ctx.boss)
    expect(idsOf(await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 }))).toEqual(['a'])

    await clock.setTime(clock.now() + 60_000)

    expect(idsOf(await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 }))).toEqual(['ungrouped'])
    expect(ran).toEqual(['window', 'hop', 'window', 'scan'])
  })

  it('gives concurrent fetches different jobs from the hop', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, max: 6 })

    await seedBusyGroup(ctx.boss, ctx.schema, clock)
    await insertGroups(ctx.boss, ctx.schema, clock, Array.from({ length: 40 }, (_, i) => `g${String(i).padStart(2, '0')}`))

    const batches = await Promise.all(Array.from({ length: 4 }, () =>
      ctx.boss!.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 })))

    const claimed = batches.flatMap(groupsOf)
    expect(new Set(claimed).size).toBe(claimed.length)
    expect(claimed.length).toBeGreaterThan(5)
  })

  it('runs the full scan while job_i18 is missing', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await seedBusyGroup(ctx.boss, ctx.schema, clock)

    const queue = await ctx.boss.getQueue(ctx.schema)
    helper.assertTruthy(queue)

    const db = await helper.getDb()
    await db.executeSql(`DROP INDEX ${ctx.schema}.${queue.table}_i18`)
    await db.close()

    await ctx.boss.insert(ctx.schema, [{ data: { id: 'ungrouped' } }, { data: { id: 'a' }, group: { id: 'a' } }])
    await clock.tick(1000)

    const ran = watchFetches(ctx.boss)
    expect(idsOf(await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 }))).toEqual(['a', 'ungrouped'])
    expect(ran).toEqual(['window', 'scan'])
  })

  it('hands out step one\'s jobs and reports the error when the hop fails', async function () {
    const clock = new TestClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock })

    await seedBusyGroup(ctx.boss, ctx.schema, clock)
    // Priority puts a1 ahead of the backlog, inside the window.
    await ctx.boss.insert(ctx.schema, [{ data: { id: 'a1' }, priority: 1, group: { id: 'a' } }, { data: { id: 'b1' }, group: { id: 'b' } }])
    await clock.tick(1000)

    const errors: Error[] = []
    ctx.boss.on('error', err => errors.push(err))
    const ran = watchFetches(ctx.boss, 'hop')

    expect(idsOf(await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 }))).toEqual(['a1'])
    expect(ran).toEqual(['window', 'hop'])
    expect(errors.map(err => err.message)).toEqual(['hop refused'])
  })

  it('keeps today\'s fetch on a key_strict_fifo queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { policy: 'key_strict_fifo' })

    await ctx.boss.insert(ctx.schema, [
      { data: { id: 'k1' }, singletonKey: 'k1', group: { id: 'a' } },
      { data: { id: 'k2' }, singletonKey: 'k2', group: { id: 'b' } }
    ])

    const ran = watchFetches(ctx.boss)
    expect(idsOf(await ctx.boss.fetch(ctx.schema, { batchSize: 5, groupConcurrency: 1 }))).toEqual(['k1', 'k2'])
    expect(ran).toEqual(['scan'])
  })

  it('claims through the hop for a worker with localGroupConcurrency', async function () {
    // This test runs on real time. A worker polls on timers, which a TestClock fires only on tick().
    ctx.boss = await helper.start({ ...ctx.bossConfig })

    await ctx.boss.send(ctx.schema, { id: 'busy-active' }, { group: { id: 'busy' } })
    await ctx.boss.insert(ctx.schema, Array.from({ length: BACKLOG }, () => ({ data: { id: 'busy' }, group: { id: 'busy' } })))

    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => { release = resolve })
    const seen: string[] = []
    const ran = watchFetches(ctx.boss)

    await ctx.boss.work<{ id: string }>(ctx.schema, { localConcurrency: 2, localGroupConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
      seen.push(job.data.id)
      if (job.data.id === 'busy-active') await blocked
    })

    // Once busy is at its limit, a poll takes step one and then the full scan. Add a after that.
    await helper.until(() => seen.includes('busy-active'), 10_000)
    ran.length = 0
    await helper.until(() => ran.join().includes('window,scan'), 10_000)
    await ctx.boss.send(ctx.schema, { id: 'a' }, { group: { id: 'a' } })

    await helper.until(() => seen.includes('a'), 10_000)
    release()

    expect(seen.filter(id => id.startsWith('busy'))).toEqual(['busy-active'])
    expect(ran).toContain('hop')
  })
})
