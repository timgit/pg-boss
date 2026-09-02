import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { assertTruthy } from './testHelper.ts'

// process.emitWarning is process-global, so a listener has to be attached and removed around the
// call under test rather than left on the boss instance. Node also dedupes nothing here — the
// once-per-option-per-instance guard is pg-boss's own, which is exactly what these assert.
async function captureDeprecations (fn: () => Promise<void>) {
  const seen: NodeJS.ErrnoException[] = []
  const listener = (w: Error) => seen.push(w as NodeJS.ErrnoException)

  process.on('warning', listener)

  try {
    await fn()
  } finally {
    process.off('warning', listener)
  }

  return seen.filter(w => w.name === 'DeprecationWarning' && w.code === 'PGBOSS_DEP_FETCH_SORT')
}

describe('priority', function () {
  it('higher priority job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const high = await ctx.boss.send(ctx.schema, null, { priority: 1 })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job.id).toBe(high)
  })

  it('descending priority order', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const low = await ctx.boss.send(ctx.schema, null, { priority: 1 })
    const medium = await ctx.boss.send(ctx.schema, null, { priority: 5 })
    const high = await ctx.boss.send(ctx.schema, null, { priority: 10 })

    const [job1] = await ctx.boss.fetch(ctx.schema)
    const [job2] = await ctx.boss.fetch(ctx.schema)
    const [job3] = await ctx.boss.fetch(ctx.schema)

    expect(job1.id).toBe(high)
    expect(job2.id).toBe(medium)
    expect(job3.id).toBe(low)
  })

  it('ignores the deprecated priority option and warns once', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const low = await ctx.boss.send(ctx.schema, null, { priority: 1 })
    const medium = await ctx.boss.send(ctx.schema, null, { priority: 5 })
    const high = await ctx.boss.send(ctx.schema, null, { priority: 10 })

    const jobs: string[] = []

    // priority: false used to skip the priority sort. The fetch index is now ordered to match the
    // fetch, so there is nothing to skip and the option is ignored — highest priority comes first.
    const deprecations = await captureDeprecations(async () => {
      for (let i = 0; i < 3; i++) {
        const [job] = await ctx.boss!.fetch(ctx.schema, { priority: false })
        jobs.push(job.id)
      }
    })

    expect(jobs).toEqual([high, medium, low])

    // Warned once per option per instance, not once per fetch.
    expect(deprecations).toHaveLength(1)
    expect(deprecations[0].message).toContain('priority: false is deprecated')
  })

  it('ignores the deprecated orderByCreatedOn option and warns once', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const first = await ctx.boss.send(ctx.schema)
    const second = await ctx.boss.send(ctx.schema)

    const jobs: string[] = []

    const deprecations = await captureDeprecations(async () => {
      for (let i = 0; i < 2; i++) {
        const [job] = await ctx.boss!.fetch(ctx.schema, { orderByCreatedOn: false })
        jobs.push(job.id)
      }
    })

    expect(jobs).toEqual([first, second])

    expect(deprecations).toHaveLength(1)
    expect(deprecations[0].message).toContain('orderByCreatedOn: false is deprecated')
  })

  it('minPriority skips jobs below threshold', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { priority: -10 })
    const normal = await ctx.boss.send(ctx.schema, null, { priority: 0 })

    const [job] = await ctx.boss.fetch(ctx.schema, { minPriority: 0 })

    expect(job.id).toBe(normal)
  })

  it('minPriority returns nothing when all jobs are below threshold', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { priority: -10 })
    await ctx.boss.send(ctx.schema, null, { priority: -5 })

    const jobs = await ctx.boss.fetch(ctx.schema, { minPriority: 0 })

    expect(jobs.length).toBe(0)
  })

  it('maxPriority skips jobs above threshold', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const low = await ctx.boss.send(ctx.schema, null, { priority: -10 })
    await ctx.boss.send(ctx.schema, null, { priority: 5 })

    const [job] = await ctx.boss.fetch(ctx.schema, { maxPriority: 0 })

    expect(job.id).toBe(low)
  })

  it('maxPriority returns nothing when all jobs are above threshold', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { priority: 5 })
    await ctx.boss.send(ctx.schema, null, { priority: 10 })

    const jobs = await ctx.boss.fetch(ctx.schema, { maxPriority: 0 })

    expect(jobs.length).toBe(0)
  })

  it('minPriority and maxPriority together fetch only jobs in range', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema, null, { priority: -10 })
    const inRange = await ctx.boss.send(ctx.schema, null, { priority: 5 })
    await ctx.boss.send(ctx.schema, null, { priority: 20 })

    const [job] = await ctx.boss.fetch(ctx.schema, { minPriority: 1, maxPriority: 10 })

    expect(job.id).toBe(inRange)
  })

  it('worker with minPriority skips jobs below threshold', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)

    const skipped = await ctx.boss.send(ctx.schema, null, { priority: -10 })
    const normal = await ctx.boss.send(ctx.schema, null, { priority: 0 })

    assertTruthy(skipped)
    assertTruthy(normal)

    await ctx.boss.work(ctx.schema, { minPriority: 0 }, async () => {})

    await spy.waitForJobWithId(normal, 'completed')
    await ctx.boss.offWork(ctx.schema)

    const [remainingJob] = await ctx.boss.findJobs(ctx.schema, { id: skipped })

    assertTruthy(remainingJob)
    expect(remainingJob.state).toBe('created')
  })

  it('worker with maxPriority skips jobs above threshold', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)

    const low = await ctx.boss.send(ctx.schema, null, { priority: -10 })
    const skipped = await ctx.boss.send(ctx.schema, null, { priority: 5 })

    assertTruthy(low)
    assertTruthy(skipped)

    await ctx.boss.work(ctx.schema, { maxPriority: 0 }, async () => {})

    await spy.waitForJobWithId(low, 'completed')
    await ctx.boss.offWork(ctx.schema)

    const [remainingJob] = await ctx.boss.findJobs(ctx.schema, { id: skipped })

    assertTruthy(remainingJob)
    expect(remainingJob.state).toBe('created')
  })
})
