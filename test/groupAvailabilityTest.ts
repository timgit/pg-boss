import { describe, expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { delay } from '../src/tools.ts'

describe('groupAvailability', function () {
  it('keeps denied grouped jobs queued while allowing ungrouped jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const deniedId = await ctx.boss.send(ctx.schema, { grouped: true }, { group: { id: 'drained' } })
    const ungroupedId = await ctx.boss.send(ctx.schema, { grouped: false })
    assertTruthy(deniedId)
    assertTruthy(ungroupedId)

    const jobs = await ctx.boss.fetch(ctx.schema, {
      batchSize: 2,
      groupConcurrency: 2,
      groupAvailability: async ({ name, candidates }) => {
        expect(name).toBe(ctx.schema)
        expect(candidates).toEqual([{
          groupId: 'drained',
          groupTier: null,
          requested: 1
        }])
        return [{ groupId: 'drained', groupTier: null, capacity: 0 }]
      }
    })

    expect(jobs.map(job => job.id)).toEqual([ungroupedId])

    const result = await helper.findJobs(ctx.schema, 'id = $1', [deniedId])
    expect(result.rows[0].state).toBe('created')
    expect(result.rows[0].started_on).toBeNull()
    expect(result.rows[0].retry_count).toBe(0)
  })

  it('limits each group to the capacity returned by the hook', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    for (let i = 0; i < 4; i++) {
      await ctx.boss.send(ctx.schema, { group: 'a', i }, { group: { id: 'a' } })
      await ctx.boss.send(ctx.schema, { group: 'b', i }, { group: { id: 'b', tier: 'paid' } })
    }

    const jobs = await ctx.boss.fetch<{ group: string }>(ctx.schema, {
      batchSize: 8,
      groupConcurrency: { default: 5, tiers: { paid: 5 } },
      groupAvailability: async ({ candidates }) => candidates.map(candidate => ({
        groupId: candidate.groupId,
        groupTier: candidate.groupTier,
        capacity: candidate.groupId === 'a' ? 2 : 1
      }))
    })

    expect(jobs.filter(job => job.groupId === 'a')).toHaveLength(2)
    expect(jobs.filter(job => job.groupId === 'b')).toHaveLength(1)
  })

  it('pages past a drained group that dominates the front of the queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    for (let i = 0; i < 100; i++) {
      await ctx.boss.send(ctx.schema, { i }, { group: { id: 'drained', tier: 'paid' } })
    }
    const availableId = await ctx.boss.send(ctx.schema, {}, { group: { id: 'available' } })
    assertTruthy(availableId)

    const checked: string[][] = []
    const [job] = await ctx.boss.fetch(ctx.schema, {
      groupConcurrency: 1,
      groupAvailability: async ({ candidates }) => {
        checked.push(candidates.map(candidate => candidate.groupId))
        return candidates.map(candidate => ({
          groupId: candidate.groupId,
          groupTier: candidate.groupTier,
          capacity: candidate.groupId === 'available' ? 1 : 0
        }))
      }
    })

    expect(checked).toEqual([['drained'], ['available']])
    expect(job.id).toBe(availableId)
    await ctx.boss.complete(ctx.schema, job.id)
  })

  it('only presents groups with database concurrency capacity to the hook', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, {}, { group: { id: 'saturated' } })
    const [active] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(active)

    await ctx.boss.send(ctx.schema, {}, { group: { id: 'saturated' } })
    const availableId = await ctx.boss.send(ctx.schema, {}, { group: { id: 'available' } })
    assertTruthy(availableId)
    // PGlite can execute the send and fetch within the same timestamp tick;
    // advance the clock so start_after < now() is deterministic.
    await delay(20)

    const seen: string[] = []
    const [job] = await ctx.boss.fetch(ctx.schema, {
      groupConcurrency: 1,
      groupAvailability: async ({ candidates }) => {
        seen.push(...candidates.map(candidate => candidate.groupId))
        return candidates.map(candidate => ({ groupId: candidate.groupId, groupTier: candidate.groupTier, capacity: 1 }))
      }
    })

    expect(seen).toEqual(['available'])
    expect(job.id).toBe(availableId)
  })

  it('fails closed when the hook throws', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, {}, { group: { id: 'group-a' } })
    assertTruthy(jobId)

    await expect(ctx.boss.fetch(ctx.schema, {
      groupConcurrency: 1,
      groupAvailability: async () => { throw new Error('coordinator unavailable') }
    })).rejects.toThrow('coordinator unavailable')

    const result = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(result.rows[0].state).toBe('created')
  })

  it('can admit one tier while denying another tier in the same group', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const defaultId = await ctx.boss.send(ctx.schema, {}, { group: { id: 'shared' } })
    const paidId = await ctx.boss.send(ctx.schema, {}, { group: { id: 'shared', tier: 'paid' } })
    assertTruthy(defaultId)
    assertTruthy(paidId)
    await delay(20)

    const seen: Array<[string, string | null]> = []
    const jobs = await ctx.boss.fetch(ctx.schema, {
      batchSize: 2,
      groupConcurrency: { default: 2, tiers: { paid: 2 } },
      groupAvailability: async ({ candidates }) => candidates.map(candidate => {
        seen.push([candidate.groupId, candidate.groupTier])
        return {
          groupId: candidate.groupId,
          groupTier: candidate.groupTier,
          capacity: candidate.groupTier === 'paid' ? 1 : 0
        }
      })
    })

    expect(seen).toHaveLength(2)
    expect(seen).toEqual(expect.arrayContaining([['shared', null], ['shared', 'paid']]))
    expect(jobs.map(job => job.id)).toEqual([paidId])

    const denied = await helper.findJobs(ctx.schema, 'id = $1', [defaultId])
    expect(denied.rows[0].state).toBe('created')
  })

  it('gates polling workers before jobs become active', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, {}, { group: { id: 'group-a' } })
    assertTruthy(jobId)

    let drained = true
    let signalChecked: () => void
    const checked = new Promise<void>(resolve => { signalChecked = resolve })
    const workerId = await ctx.boss.work(ctx.schema, {
      groupConcurrency: 1,
      pollingIntervalSeconds: 0.5,
      groupAvailability: async ({ candidates }) => {
        signalChecked()
        return candidates.map(candidate => ({
          groupId: candidate.groupId,
          groupTier: candidate.groupTier,
          capacity: drained ? 0 : 1
        }))
      }
    }, async () => {})

    await checked
    await delay(100)

    const beforeRelease = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(beforeRelease.rows[0].state).toBe('created')

    drained = false
    ctx.boss.notifyWorker(workerId)

    const completed = await spy.waitForJobWithId(jobId, 'completed')
    expect(completed.state).toBe('completed')
  })

  it('validates hook configuration and decisions', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(ctx.boss.fetch(ctx.schema, {
      groupAvailability: async () => []
    })).rejects.toThrow('groupAvailability requires groupConcurrency')

    await ctx.boss.send(ctx.schema, {}, { group: { id: 'group-a' } })
    await expect(ctx.boss.fetch(ctx.schema, {
      groupConcurrency: 1,
      groupAvailability: async () => [{ groupId: 'group-a', groupTier: null, capacity: -1 }]
    })).rejects.toThrow('groupAvailability capacity for "group-a" must be an integer >= 0')
  })
})

describe('queueAvailability', function () {
  it('keeps ungrouped jobs queued when the queue has no external capacity', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, {})
    assertTruthy(jobId)

    const jobs = await ctx.boss.fetch(ctx.schema, {
      queueAvailability: async ({ name, requested }) => {
        expect(name).toBe(ctx.schema)
        expect(requested).toBe(1)
        return 0
      }
    })

    expect(jobs).toEqual([])
    const result = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(result.rows[0].state).toBe('created')
    expect(result.rows[0].started_on).toBeNull()
  })

  it('reduces the total fetch batch without requiring group concurrency', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    for (let i = 0; i < 5; i++) {
      await ctx.boss.send(ctx.schema, { i })
    }

    const jobs = await ctx.boss.fetch(ctx.schema, {
      batchSize: 5,
      queueAvailability: async () => 2
    })

    expect(jobs).toHaveLength(2)
  })

  it('short-circuits group discovery when queue capacity is zero', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, {}, { group: { id: 'group-a' } })
    let groupHookCalled = false

    const jobs = await ctx.boss.fetch(ctx.schema, {
      groupConcurrency: 1,
      queueAvailability: async () => 0,
      groupAvailability: async () => {
        groupHookCalled = true
        return []
      }
    })

    expect(jobs).toEqual([])
    expect(groupHookCalled).toBe(false)
  })

  it('validates the returned queue capacity', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(ctx.boss.fetch(ctx.schema, {
      queueAvailability: async () => -1
    })).rejects.toThrow('queueAvailability must resolve with an integer >= 0')
  })

  it('gates ungrouped polling workers', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const spy = ctx.boss.getSpy(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema, {})
    assertTruthy(jobId)

    let available = false
    let signalChecked: () => void
    const checked = new Promise<void>(resolve => { signalChecked = resolve })
    const workerId = await ctx.boss.work(ctx.schema, {
      pollingIntervalSeconds: 0.5,
      queueAvailability: async () => {
        signalChecked()
        return available ? 1 : 0
      }
    }, async () => {})

    await checked
    await delay(100)
    const blocked = await helper.findJobs(ctx.schema, 'id = $1', [jobId])
    expect(blocked.rows[0].state).toBe('created')

    available = true
    ctx.boss.notifyWorker(workerId)

    const completed = await spy.waitForJobWithId(jobId, 'completed')
    expect(completed.state).toBe('completed')
  })
})
