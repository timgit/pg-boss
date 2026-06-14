import { expect, vi } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'
import Manager from '../src/manager.ts'

describe('heartbeat', function () {
  it('should auto-heartbeat during work and complete normally', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10 })

    const jobId = await ctx.boss.send(ctx.schema, { value: 1 })
    assertTruthy(jobId)

    let processedId: string | undefined

    // Use short heartbeatRefreshSeconds so the timer fires during the handler
    await ctx.boss.work(ctx.schema, { heartbeatRefreshSeconds: 0.5 }, async ([job]) => {
      processedId = job.id
      expect(job.heartbeatSeconds).toBe(10)

      // Record heartbeat_on before the timer fires
      const db = await helper.getDb()
      const { rows: before } = await db.executeSql(
        `SELECT heartbeat_on FROM ${ctx.schema}.job WHERE id = $1`,
        [jobId]
      )

      // Wait long enough for the heartbeat timer to fire
      await delay(1000)

      const { rows: after } = await db.executeSql(
        `SELECT heartbeat_on FROM ${ctx.schema}.job WHERE id = $1`,
        [jobId]
      )
      await db.close()

      // heartbeat_on should have been updated by the timer
      expect(after[0].heartbeat_on.getTime()).toBeGreaterThan(before[0].heartbeat_on.getTime())
    })

    await delay(2000)

    expect(processedId).toBe(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(job)
    expect(job.state).toBe('completed')
  })

  it('should fail job by heartbeat timeout when no heartbeat is sent', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, monitorIntervalSeconds: 1, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 0 })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    // fetch without completing - no automatic heartbeat in fetch mode
    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)

    // manually backdate heartbeat_on to simulate timeout
    const db = await helper.getDb()
    await db.executeSql(
      `UPDATE ${ctx.schema}.job SET heartbeat_on = now() - interval '20 seconds' WHERE id = $1`,
      [jobId]
    )
    await db.close()

    await ctx.boss.supervise(ctx.schema)

    const failedJob = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(failedJob)
    expect(failedJob.state).toBe('failed')
    expect(failedJob.output).toEqual({ value: { message: 'job heartbeat timeout' } })
  })

  it('should extend heartbeat via manual touch', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10 })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)

    const result = await ctx.boss.touch(ctx.schema, jobId)
    expect(result.affected).toBe(1)

    // Verify heartbeat_on was updated
    const db = await helper.getDb()
    const { rows } = await db.executeSql(
      `SELECT heartbeat_on FROM ${ctx.schema}.job WHERE id = $1`,
      [jobId]
    )
    await db.close()

    expect(rows[0].heartbeat_on).toBeTruthy()
  })

  it('should cascade heartbeat config from queue to job', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 30 })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true })
    assertTruthy(job)

    expect(job.heartbeatSeconds).toBe(30)
    expect(job.heartbeatOn).toBeTruthy()
  })

  it('should not affect jobs without heartbeat config', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, monitorIntervalSeconds: 1, noDefault: true })

    // Queue without heartbeat
    await ctx.boss.createQueue(ctx.schema, { retryLimit: 0 })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)
    expect(job.heartbeatSeconds).toBeNull()

    // Supervise should not fail it via heartbeat
    await ctx.boss.supervise(ctx.schema)

    const activeJob = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(activeJob)
    expect(activeJob.state).toBe('active')
  })

  it('should allow per-job heartbeat override', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 30 })

    const jobId = await ctx.boss.send(ctx.schema, null, { heartbeatSeconds: 60 })
    assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)
    expect(job.heartbeatSeconds).toBe(60)
  })

  it('should return correct count from touch with multiple ids', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10 })

    const id1 = await ctx.boss.send(ctx.schema)
    const id2 = await ctx.boss.send(ctx.schema)
    assertTruthy(id1)
    assertTruthy(id2)

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
    expect(jobs.length).toBe(2)

    const result = await ctx.boss.touch(ctx.schema, [id1, id2])
    expect(result.affected).toBe(2)
  })

  it('touch should return 0 affected for non-active job', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10 })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    // Job is in created state, not active
    const result = await ctx.boss.touch(ctx.schema, jobId)
    expect(result.affected).toBe(0)
  })

  it('should retry job on heartbeat timeout and preserve heartbeat config', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 1 })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)

    // backdate heartbeat_on to simulate timeout
    const db = await helper.getDb()
    await db.executeSql(
      `UPDATE ${ctx.schema}.job SET heartbeat_on = now() - interval '20 seconds' WHERE id = $1`,
      [jobId]
    )
    await db.close()

    await ctx.boss.supervise(ctx.schema)

    const retriedJob = await ctx.boss.getJobById(ctx.schema, jobId)
    assertTruthy(retriedJob)
    expect(retriedJob.state).toBe('retry')

    // Fetch the retried job and verify heartbeat config is preserved
    const [job2] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job2)
    expect(job2.id).toBe(jobId)
    expect(job2.heartbeatSeconds).toBe(10)
  })

  it('should reject heartbeatSeconds less than 10', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)

    await expect(
      ctx.boss.send(ctx.schema, null, { heartbeatSeconds: 5 })
    ).rejects.toThrow('heartbeatSeconds must be an integer >= 10')
  })

  it('should reject non-integer heartbeatSeconds', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)

    await expect(
      ctx.boss.send(ctx.schema, null, { heartbeatSeconds: 10.5 })
    ).rejects.toThrow('heartbeatSeconds must be an integer >= 10')
  })

  it('should emit error when heartbeat timer fails', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10 })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    const errors: any[] = []
    ctx.boss.on('error', (err: any) => errors.push(err))

    const spy = vi.spyOn(Manager.prototype, 'touch').mockRejectedValue(new Error('touch test error'))

    await ctx.boss.work(ctx.schema, { heartbeatRefreshSeconds: 0.5 }, async ([job]) => {
      await delay(1000)
    })

    await delay(2000)

    spy.mockRestore()

    expect(errors.length).toBeGreaterThan(0)
  })

  it('should reject invalid heartbeatSeconds on createQueue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await expect(
      ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 5 })
    ).rejects.toThrow('heartbeatSeconds must be an integer >= 10')
  })

  it('should reject invalid heartbeatRefreshSeconds on work', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 30 })

    await expect(
      ctx.boss.work(ctx.schema, { heartbeatRefreshSeconds: 0 }, async () => {})
    ).rejects.toThrow('heartbeatRefreshSeconds must be a number > 0')
  })

  it('should support heartbeatSeconds via insert', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)

    await ctx.boss.insert(ctx.schema, [
      { data: { index: 1 }, heartbeatSeconds: 20 },
      { data: { index: 2 }, heartbeatSeconds: 30 }
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
    expect(jobs.length).toBe(2)

    const sorted = jobs.sort((a, b) => a.data.index - b.data.index)
    expect(sorted[0].heartbeatSeconds).toBe(20)
    expect(sorted[1].heartbeatSeconds).toBe(30)
  })

  it('should update queue heartbeatSeconds', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)

    // Initially no heartbeat
    let queue = await ctx.boss.getQueue(ctx.schema)
    assertTruthy(queue)
    expect(queue.heartbeatSeconds).toBeNull()

    // Update with heartbeat
    await ctx.boss.updateQueue(ctx.schema, { heartbeatSeconds: 30 })

    queue = await ctx.boss.getQueue(ctx.schema)
    assertTruthy(queue)
    expect(queue.heartbeatSeconds).toBe(30)

    // Job should inherit updated config
    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    assertTruthy(job)
    expect(job.heartbeatSeconds).toBe(30)
  })
})
