import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

// Sends `count` jobs one at a time so created_on is strictly increasing, which is what the default
// ordering and the cursor are defined against.
async function sendSequence (queue: string, count: number): Promise<string[]> {
  const ids: string[] = []

  for (let i = 0; i < count; i++) {
    const id = await ctx.boss!.send(queue, { seq: i })
    helper.assertTruthy(id)
    ids.push(id)
  }

  return ids
}

describe('findJobs filters', function () {
  it('should filter by an explicit state list', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const created = await ctx.boss.send(ctx.schema, { keep: true })
    helper.assertTruthy(created)

    const toComplete = await ctx.boss.send(ctx.schema, { keep: false })
    helper.assertTruthy(toComplete)

    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    const completed = await ctx.boss.findJobs(ctx.schema, { states: ['completed'] })

    expect(completed.length).toBe(1)
    expect(completed[0].id).toBe(job.id)

    const rest = await ctx.boss.findJobs(ctx.schema, { states: ['created', 'retry'] })

    expect(rest.length).toBe(1)
    expect(rest[0].id).not.toBe(job.id)
  })

  it('should accept several states at once', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await sendSequence(ctx.schema, 3)

    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    const jobs = await ctx.boss.findJobs(ctx.schema, { states: ['created', 'completed'] })

    expect(jobs.length).toBe(3)
  })

  it('should reject combining states with queued', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.findJobs(ctx.schema, { queued: true, states: ['completed'] })
    }).rejects.toThrow(/states/)
  })

  it('should reject an unknown state', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-expect-error deliberately passing a state that does not exist
      await ctx.boss.findJobs(ctx.schema, { states: ['nope'] })
    }).rejects.toThrow(/unknown job state/)
  })

  it('should reject an empty state list', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.findJobs(ctx.schema, { states: [] })
    }).rejects.toThrow(/non-empty/)
  })

  it('should bound the result with limit', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await sendSequence(ctx.schema, 5)

    const jobs = await ctx.boss.findJobs(ctx.schema, { limit: 2 })

    expect(jobs.length).toBe(2)
  })

  it('should reject a limit below one', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.findJobs(ctx.schema, { limit: 0 })
    }).rejects.toThrow(/limit/)
  })

  it('should return the oldest jobs first by default once ordering is on', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids = await sendSequence(ctx.schema, 4)

    const jobs = await ctx.boss.findJobs(ctx.schema, { limit: 4 })

    expect(jobs.map(j => j.id)).toEqual(ids)
  })

  it('should reverse the order on request', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids = await sendSequence(ctx.schema, 4)

    const jobs = await ctx.boss.findJobs(ctx.schema, { limit: 4, direction: 'desc' })

    expect(jobs.map(j => j.id)).toEqual([...ids].reverse())
  })

  it('should order by startAfter', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const later = await ctx.boss.send(ctx.schema, { when: 'later' }, { startAfter: 60 })
    const sooner = await ctx.boss.send(ctx.schema, { when: 'sooner' }, { startAfter: 10 })

    const jobs = await ctx.boss.findJobs(ctx.schema, { orderBy: 'startAfter' })

    expect(jobs.map(j => j.id)).toEqual([sooner, later])
  })

  it('should reject an unsupported orderBy column', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-expect-error deliberately sorting on a column that is not offered
      await ctx.boss.findJobs(ctx.schema, { orderBy: 'output' })
    }).rejects.toThrow(/orderBy/)
  })

  it('should page forward with a cursor', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids = await sendSequence(ctx.schema, 5)

    const pages: string[] = []
    let cursor: string | undefined

    for (;;) {
      const page: { id: string }[] = await ctx.boss.findJobs(ctx.schema, { limit: 2, cursor })

      if (page.length === 0) break

      pages.push(...page.map(j => j.id))
      cursor = page[page.length - 1].id
    }

    expect(pages).toEqual(ids)
  })

  it('should page backward with a cursor', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids = await sendSequence(ctx.schema, 4)

    const first = await ctx.boss.findJobs(ctx.schema, { limit: 2, direction: 'desc' })
    const second = await ctx.boss.findJobs(ctx.schema, { limit: 2, direction: 'desc', cursor: first[1].id })

    expect([...first, ...second].map(j => j.id)).toEqual([...ids].reverse())
  })

  it('should not repeat a row when one is deleted between pages', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids = await sendSequence(ctx.schema, 5)

    const first = await ctx.boss.findJobs(ctx.schema, { limit: 2 })

    expect(first.map(j => j.id)).toEqual(ids.slice(0, 2))

    // an OFFSET-based pager would now shift and skip ids[2]
    await ctx.boss.deleteJob(ctx.schema, ids[0])

    const second = await ctx.boss.findJobs(ctx.schema, { limit: 2, cursor: first[1].id })

    expect(second.map(j => j.id)).toEqual(ids.slice(2, 4))
  })

  it('should return nothing for a cursor that names no job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await sendSequence(ctx.schema, 3)

    const jobs = await ctx.boss.findJobs(ctx.schema, { limit: 2, cursor: '3f2b1c8e-0000-4000-8000-000000000000' })

    expect(jobs.length).toBe(0)
  })

  it('should combine a state filter with paging', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const ids = await sendSequence(ctx.schema, 4)

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
    await ctx.boss.complete(ctx.schema, jobs.map(j => j.id))

    const page = await ctx.boss.findJobs(ctx.schema, { states: ['completed'], limit: 1 })

    expect(page.length).toBe(1)
    expect(page[0].id).toBe(ids[0])

    const next = await ctx.boss.findJobs(ctx.schema, { states: ['completed'], limit: 1, cursor: page[0].id })

    expect(next.map(j => j.id)).toEqual([ids[1]])
  })

  it('should leave an unordered call unordered', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await sendSequence(ctx.schema, 3)

    // no limit, cursor, orderBy or direction: the statement is the one findJobs has always issued
    const jobs = await ctx.boss.findJobs(ctx.schema, { queued: true })

    expect(jobs.length).toBe(3)
  })
})

describe('getJobByKey', function () {
  it('should return the most recent job for a key', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const first = await ctx.boss.send(ctx.schema, { attempt: 1 }, { singletonKey: 'order-1' })
    helper.assertTruthy(first)

    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    const second = await ctx.boss.send(ctx.schema, { attempt: 2 }, { singletonKey: 'order-1' })
    helper.assertTruthy(second)

    const found = await ctx.boss.getJobByKey<{ attempt: number }>(ctx.schema, 'order-1')

    helper.assertTruthy(found)
    expect(found.id).toBe(second)
    expect(found.data.attempt).toBe(2)
  })

  it('should narrow to the queued job for a key', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const first = await ctx.boss.send(ctx.schema, { attempt: 1 }, { singletonKey: 'order-2' })
    helper.assertTruthy(first)

    const second = await ctx.boss.send(ctx.schema, { attempt: 2 }, { singletonKey: 'order-2' })
    helper.assertTruthy(second)

    // the newest is fetched and completed, so only the older one is still queued
    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    const found = await ctx.boss.getJobByKey(ctx.schema, 'order-2', { queued: true })

    helper.assertTruthy(found)
    expect(found.id).toBe(second)
    expect(found.state).toBe('created')
  })

  it('should not see another key', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, { n: 1 }, { singletonKey: 'order-3' })

    expect(await ctx.boss.getJobByKey(ctx.schema, 'order-4')).toBeNull()
  })

  it('should return null when the queue has no job for the key', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    expect(await ctx.boss.getJobByKey(ctx.schema, 'never-used')).toBeNull()
  })

  it('should reject a missing key', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      // @ts-expect-error deliberately calling without the required key
      await ctx.boss.getJobByKey(ctx.schema)
    }).rejects.toThrow(/singleton key/)
  })
})
