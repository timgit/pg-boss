import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import type { PgBoss } from '../src/index.ts'
import { ctx } from './hooks.ts'

// A handler that ignores job.signal and returns only when the test releases it.
function heldHandler () {
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  return { release, released }
}

function overrunWarnings (boss: PgBoss) {
  const warnings: any[] = []
  boss.on('warning', warning => {
    if ((warning.data as any)?.type === 'handler_overrun') warnings.push(warning)
  })
  return warnings
}

describe('handler overrun', function () {
  it('should not fetch the retry while the attempt that outran its timeout is still running', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    const jobId = await boss.send(ctx.schema, null, { retryLimit: 1, retryDelay: 0, expireInSeconds: 1 })
    assertTruthy(jobId)

    const first = heldHandler()
    const attempts: number[] = []
    let running = 0
    let maxRunning = 0

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
      attempts.push(job.retryCount)
      running++
      maxRunning = Math.max(maxRunning, running)

      try {
        if (job.retryCount === 0) await first.released
      } finally {
        running--
      }
    })

    // Past the 1s timeout and several polling intervals: the retry is ready, but the worker is still
    // held by the first attempt.
    await helper.until(() => attempts.length === 1)
    await delay(2500)

    expect(attempts).toEqual([0])
    expect(warnings.length).toBe(1)
    expect(warnings[0].data).toMatchObject({ queue: ctx.schema, jobs: [jobId], expireInSeconds: 1 })

    const failed = await boss.getJobById(ctx.schema, jobId)
    assertTruthy(failed)
    expect(failed.state).toBe('retry')

    first.release()

    await helper.until(async () => (await boss.getJobById(ctx.schema, jobId))?.state === 'completed')

    expect(attempts).toEqual([0, 1])
    expect(maxRunning).toBe(1)
  })

  it('a graceful stop waits for a handler that outran its timeout', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    await boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    const held = heldHandler()
    let handlerStarted = false
    let handlerEnded = false

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      handlerStarted = true
      await held.released
      handlerEnded = true
    })

    // Past the 1s timeout, so the batch is already failed when the stop begins.
    await helper.until(() => handlerStarted)
    await delay(1500)

    let stopped = false
    let handlerEndedBeforeStop = false
    const stopping = boss.stop({ timeout: 10000 }).then(() => {
      stopped = true
      handlerEndedBeforeStop = handlerEnded
    })

    await delay(500)

    expect(stopped).toBe(false)

    held.release()
    await stopping

    expect(handlerEndedBeforeStop).toBe(true)
    expect(warnings.length).toBe(1)
  })

  it('a graceful stop stops waiting for a handler that outran its timeout once its grace is spent', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const boss = ctx.boss
    const warnings = overrunWarnings(boss)

    await boss.send(ctx.schema, null, { retryLimit: 0, expireInSeconds: 1 })

    const held = heldHandler()
    let handlerStarted = false

    await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, () => {
      handlerStarted = true
      return held.released
    })

    await helper.until(() => handlerStarted)
    await delay(1500)

    expect(warnings.length).toBe(1)

    try {
      const started = Date.now()
      await boss.stop({ timeout: 1000 })

      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      held.release()
    }
  })
})
