import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

// A poll interval no test waits out, so a job processed quickly shows the worker was woken.
const pollingIntervalSeconds = 30

async function waitFor (check: () => boolean, ms = 3000) {
  for (let waited = 0; !check() && waited < ms; waited += 100) {
    await delay(100)
  }
}

describe('queue pause', function () {
  it('should return no jobs from a paused queue and fetch them again once resumed', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.pauseQueue(ctx.schema)

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    expect(await ctx.boss.fetch(ctx.schema)).toEqual([])

    await ctx.boss.resumeQueue(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job?.id).toBe(jobId)
  })

  it('should report paused and pausedOn from getQueue()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const running = await ctx.boss.getQueue(ctx.schema)
    expect(running?.paused).toBe(false)
    expect(running?.pausedOn).toBeNull()

    await ctx.boss.pauseQueue(ctx.schema)

    const paused = await ctx.boss.getQueue(ctx.schema)
    expect(paused?.paused).toBe(true)
    expect(paused?.pausedOn).toBeInstanceOf(Date)

    await ctx.boss.resumeQueue(ctx.schema)

    const resumed = await ctx.boss.getQueue(ctx.schema)
    expect(resumed?.paused).toBe(false)
    expect(resumed?.pausedOn).toBeNull()
  })

  it('should keep the first pause time when a paused queue is paused again', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.pauseQueue(ctx.schema)
    const first = await ctx.boss.getQueue(ctx.schema)

    await delay(50)
    await ctx.boss.pauseQueue(ctx.schema)
    const second = await ctx.boss.getQueue(ctx.schema)

    expect(second?.pausedOn).toEqual(first?.pausedOn)
  })

  it('should reject pausing or resuming a queue that does not exist', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const missing = `${ctx.schema}_missing`

    await expect(ctx.boss.pauseQueue(missing)).rejects.toThrow(`Queue ${missing} does not exist`)
    await expect(ctx.boss.resumeQueue(missing)).rejects.toThrow(`Queue ${missing} does not exist`)
  })

  it('should apply a pause made through another instance without a queue cache refresh', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const other = await helper.start({ ...ctx.bossConfig, noDefault: true })

    try {
      // The send loads the queue into this instance's cache before the other instance pauses it.
      await ctx.boss.send(ctx.schema)
      await other.pauseQueue(ctx.schema)

      expect(await ctx.boss.fetch(ctx.schema)).toEqual([])

      await other.resumeQueue(ctx.schema)

      expect(await ctx.boss.fetch(ctx.schema)).toHaveLength(1)
    } finally {
      await other.stop({ graceful: false })
    }
  })

  describe.each([
    { policy: 'standard', fetchOptions: {} },
    { policy: 'standard', fetchOptions: { groupConcurrency: 2 } },
    { policy: 'singleton', fetchOptions: { batchSize: 5 } },
    { policy: 'stately', fetchOptions: { batchSize: 5 } },
    { policy: 'key_strict_fifo', fetchOptions: {} }
  ])('a paused $policy queue with fetch options $fetchOptions', function ({ policy, fetchOptions }) {
    it('should return no jobs', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      await ctx.boss.createQueue(ctx.schema, { policy })

      await ctx.boss.send(ctx.schema, {}, { singletonKey: 'a', group: { id: 'g' } })
      await ctx.boss.pauseQueue(ctx.schema)

      expect(await ctx.boss.fetch(ctx.schema, fetchOptions)).toEqual([])

      await ctx.boss.resumeQueue(ctx.schema)

      expect(await ctx.boss.fetch(ctx.schema, fetchOptions)).toHaveLength(1)
    })
  })

  it('should let an active job complete while its queue is paused', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)

    await ctx.boss.pauseQueue(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    const completed = await ctx.boss.getJobById(ctx.schema, job.id)
    expect(completed?.state).toBe('completed')
  })

  it('should keep a worker idle while paused and wake it on resume', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.pauseQueue(ctx.schema)

    // The worker's first fetch finds the job, so only the pause keeps it from running.
    let processed = 0
    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => { processed++ })

    await delay(500)
    expect(processed).toBe(0)

    await ctx.boss.resumeQueue(ctx.schema)

    await waitFor(() => processed > 0)
    expect(processed).toBe(1)
  })

  it('should let drain() resolve on a paused queue and leave its backlog', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.pauseQueue(ctx.schema)

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => {})

    const result = await ctx.boss.drain()

    expect(result).toEqual({ processed: 0, failed: 0, timedOut: false })

    await ctx.boss.resumeQueue(ctx.schema)

    const after = await ctx.boss.drain()
    expect(after.processed).toBe(1)
  })
})

helper.describeListenNotify('queue pause with listen/notify', function () {
  it('should wake another instance\'s worker via NOTIFY on resume', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, useListenNotify: true, noDefault: true })
    const other = await helper.start({ ...ctx.bossConfig, useListenNotify: true, noDefault: true })

    try {
      await ctx.boss.createQueue(ctx.schema, { notify: true })
      await ctx.boss.pauseQueue(ctx.schema)

      let processed = 0
      await ctx.boss.work(ctx.schema, { pollingIntervalSeconds }, async () => { processed++ })

      // The send's own NOTIFY wakes the worker into a fetch the pause empties, then it waits out its poll.
      await ctx.boss.send(ctx.schema)
      await delay(500)
      expect(processed).toBe(0)

      await other.resumeQueue(ctx.schema)

      await waitFor(() => processed > 0)
      expect(processed).toBe(1)
    } finally {
      await other.stop({ graceful: false })
    }
  })
})
