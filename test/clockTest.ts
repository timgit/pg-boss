import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import type { Clock, ClockTimer } from '../src/types.ts'

// Delegates to real time while recording every call, so a run proves the runtime schedules and
// reads time only through the option and that stop() releases every timer it took out.
class RecordingClock implements Clock {
  calls = { now: 0, setTimeout: 0, setInterval: 0 }
  live = new Set<ClockTimer>()

  now () {
    this.calls.now++
    return Date.now()
  }

  setTimeout (fn: () => void, ms: number) {
    this.calls.setTimeout++
    const handle: NodeJS.Timeout = setTimeout(() => {
      this.live.delete(handle)
      fn()
    }, ms)
    this.live.add(handle)
    return handle
  }

  clearTimeout (handle: ClockTimer) {
    this.live.delete(handle)
    clearTimeout(handle as NodeJS.Timeout)
  }

  setInterval (fn: () => void, ms: number) {
    this.calls.setInterval++
    const handle = setInterval(fn, ms)
    this.live.add(handle)
    return handle
  }

  clearInterval (handle: ClockTimer) {
    this.live.delete(handle)
    clearInterval(handle as NodeJS.Timeout)
  }
}

describe('clock option', function () {
  it('routes timers and time reads through the clock and releases every timer on stop', async function () {
    const clock = new RecordingClock()
    ctx.boss = await helper.start({ ...ctx.bossConfig, clock, supervise: true, schedule: true, __test__enableSpies: true })

    const queue = ctx.schema
    await ctx.boss.createQueue(queue)
    await ctx.boss.work(queue, { pollingIntervalSeconds: 1 }, async () => {})
    const spy = ctx.boss.getSpy(queue)

    const id = await ctx.boss.send(queue)
    await spy.waitForJobWithId(id!, 'completed')

    // supervise, cron, skew, bam, flow, queue-cache and wip intervals
    expect(clock.calls.setInterval).toBeGreaterThanOrEqual(7)
    // the worker's poll delay
    expect(clock.calls.setTimeout).toBeGreaterThanOrEqual(1)
    expect(clock.calls.now).toBeGreaterThan(0)
    expect(clock.live.size).toBeGreaterThan(0)

    await ctx.boss.stop({ graceful: true })
    ctx.boss = undefined

    expect(clock.live.size).toBe(0)
  })
})
