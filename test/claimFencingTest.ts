import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { delay } from '../src/tools.ts'

async function reclaim (id: string) {
  const db = await helper.getDb()
  await db.executeSql(
    `UPDATE ${ctx.schema}.job SET heartbeat_on = now() - interval '20 seconds' WHERE id = $1`,
    [id]
  )
  await db.close()

  await ctx.boss!.supervise(ctx.schema)
  const [retry] = await ctx.boss!.fetch(ctx.schema)
  assertTruthy(retry)
  expect(retry.id).toBe(id)
  expect(retry.retryCount).toBe(1)
  return retry
}

describe.each([false, true])('worker claim fencing (distributed=%s)', distributed => {
  it('does not complete or fail a newer attempt after its heartbeat claim expires', async () => {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: distributed, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 1, retryDelay: 0 })
    const id = await ctx.boss.send(ctx.schema, { value: 1 })
    assertTruthy(id)

    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    await ctx.boss.work(ctx.schema, { heartbeatRefreshSeconds: 9 }, async ([job]) => {
      expect(job.retryCount).toBe(0)
      entered()
      await gate
      return { by: 'old worker' }
    })
    await started

    const retry = await reclaim(id)
    const stopping = ctx.boss.offWork(ctx.schema, { wait: true })
    release()
    await stopping

    const active = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(active)
    expect(active.state).toBe('active')
    expect(active.retryCount).toBe(retry.retryCount)
    expect(active.output).toEqual({ value: { message: 'job heartbeat timeout' } })

    await ctx.boss.complete(ctx.schema, id, { by: 'new worker' })
    const completed = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(completed)
    expect(completed.state).toBe('completed')
    expect(completed.output).toEqual({ by: 'new worker' })
  })

  it('does not let a stale handler failure spend the newer attempt', async () => {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: distributed, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 2, retryDelay: 0 })
    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    await ctx.boss.work(ctx.schema, { heartbeatRefreshSeconds: 9 }, async () => {
      entered()
      await gate
      throw new Error('stale handler failure')
    })
    await started

    await reclaim(id)
    const stopping = ctx.boss.offWork(ctx.schema, { wait: true })
    release()
    await stopping

    const active = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(active)
    expect(active.state).toBe('active')
    expect(active.retryCount).toBe(1)
    expect(active.output).toEqual({ value: { message: 'job heartbeat timeout' } })
  })

  it('still fails an owned attempt when its handler throws', async () => {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: distributed, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { retryLimit: 0 })
    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    await ctx.boss.work(ctx.schema, async () => {
      entered()
      throw new Error('owned handler failure')
    })
    await started
    await ctx.boss.offWork(ctx.schema, { wait: true })

    const failed = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(failed)
    expect(failed.state).toBe('failed')
    expect(failed.output).toMatchObject({ name: 'Error', message: 'owned handler failure' })
  })

  it('settles only still-owned claims in a regular batch', async () => {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: distributed, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 1, retryDelay: 0 })
    const staleId = await ctx.boss.send(ctx.schema, { stale: true })
    const ownedId = await ctx.boss.send(ctx.schema, { stale: false })
    assertTruthy(staleId)
    assertTruthy(ownedId)

    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    await ctx.boss.work(ctx.schema, { batchSize: 2, heartbeatRefreshSeconds: 9 }, async () => {
      entered()
      await gate
    })
    await started

    await reclaim(staleId)
    const stopping = ctx.boss.offWork(ctx.schema, { wait: true })
    release()
    await stopping

    const stale = await ctx.boss.getJobById(ctx.schema, staleId)
    const owned = await ctx.boss.getJobById(ctx.schema, ownedId)
    assertTruthy(stale)
    assertTruthy(owned)
    expect(stale.state).toBe('active')
    expect(owned.state).toBe('completed')
  })

  it.each(['completed', 'failed', 'deadletter'] as const)('settles only still-owned claims in a per-job batch (%s)', async status => {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: distributed, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 1, retryDelay: 0 })
    const staleId = await ctx.boss.send(ctx.schema, { stale: true })
    const ownedId = await ctx.boss.send(ctx.schema, { stale: false })
    assertTruthy(staleId)
    assertTruthy(ownedId)

    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    await ctx.boss.work(ctx.schema, { batchSize: 2, perJobResults: true, heartbeatRefreshSeconds: 9 }, async jobs => {
      entered()
      await gate
      return jobs.map(job => ({ id: job.id, status, output: { by: 'old worker' } }))
    })
    await started

    await reclaim(staleId)
    const stopping = ctx.boss.offWork(ctx.schema, { wait: true })
    release()
    await stopping

    const stale = await ctx.boss.getJobById(ctx.schema, staleId)
    const owned = await ctx.boss.getJobById(ctx.schema, ownedId)
    assertTruthy(stale)
    assertTruthy(owned)
    expect(stale.state).toBe('active')
    expect(stale.output).toEqual({ value: { message: 'job heartbeat timeout' } })
    expect(owned.state).toBe(status === 'completed' ? 'completed' : status === 'failed' ? 'retry' : 'failed')
    expect(owned.output).toEqual({ by: 'old worker' })
  })

  it('aborts a handler when its heartbeat discovers a lost claim', async () => {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__distributed: distributed, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { heartbeatSeconds: 10, retryLimit: 1, retryDelay: 0 })
    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let signal: AbortSignal | undefined
    await ctx.boss.work(ctx.schema, { heartbeatRefreshSeconds: 0.5 }, async ([job]) => {
      signal = job.signal
      entered()
      await gate
    })
    await started

    await reclaim(id)
    const stopping = ctx.boss.offWork(ctx.schema, { wait: true })
    await Promise.race([
      (async () => { while (!signal?.aborted) await delay(20) })(),
      delay(3000).then(() => { throw new Error('lost claim did not abort the handler') })
    ])
    release()
    await stopping

    const active = await ctx.boss.getJobById(ctx.schema, id)
    assertTruthy(active)
    expect(active.state).toBe('active')
    expect(active.retryCount).toBe(1)
  })
})
