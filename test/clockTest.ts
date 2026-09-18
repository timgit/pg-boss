import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import type { Clock, ClockTimer } from '../src/types.ts'

// Delegates to real time while recording every call, so a run proves the runtime schedules and
// reads time only through the option and that stop() releases every timer it took out. The periods
// are recorded, not just the calls, so a timer can be matched back to whoever asked for it.
class RecordingClock implements Clock {
  reads = 0
  readonly armed = { setTimeout: [] as number[], setInterval: [] as number[] }
  readonly live = new Set<ClockTimer>()

  now () {
    this.reads++
    return Date.now()
  }

  setTimeout (fn: () => void, ms: number) {
    this.armed.setTimeout.push(ms)
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
    this.armed.setInterval.push(ms)
    const handle = setInterval(fn, ms)
    this.live.add(handle)
    return handle
  }

  clearInterval (handle: ClockTimer) {
    this.live.delete(handle)
    clearInterval(handle as NodeJS.Timeout)
  }
}

// A period of its own for every subsystem that takes a timer, so what the clock recorded names the
// subsystem that asked for it instead of being counted. Distinct, and none of them a period the
// runtime fixes for itself. cron's is under the 45-second ceiling its own option asserts.
const PERIOD_SECONDS = {
  cron: 29,
  supervise: 61,
  bam: 71,
  flow: 73,
  skew: 79,
  queueCache: 83
}

// Timers that schedule the next run once the last one has finished, for two different reasons. The
// four interval claims chain from the claim itself, so that one instance in a deployment runs the
// pass per interval without a tick that lands a little short losing the claim for a whole one (see
// ClaimTimer). The skew check chains so that a slow round trip costs its own duration instead of
// having the next check fire on top of it.
const CHAINED = ['supervise', 'cron', 'bam', 'flow', 'skew'] as const

// Local bookkeeping with nothing to pile up, which still repeats on a period of its own.
const REPEATING = ['queueCache'] as const

// A worker's poll delay is the one timer named by a bound rather than a value: it is the worker's
// interval less however long the poll before it took, so it never lands on a round number. Short
// enough that nothing else can be mistaken for it, since every period above is far longer.
const WORKER_POLL_SECONDS = 7

describe('clock option', function () {
  it('routes timers and time reads through the clock and releases every timer on stop', async function () {
    const clock = new RecordingClock()

    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      clock,
      supervise: true,
      schedule: true,
      migrate: true,
      __test__enableSpies: true,
      cronMonitorIntervalSeconds: PERIOD_SECONDS.cron,
      superviseIntervalSeconds: PERIOD_SECONDS.supervise,
      bamIntervalSeconds: PERIOD_SECONDS.bam,
      flowIntervalSeconds: PERIOD_SECONDS.flow,
      clockMonitorIntervalSeconds: PERIOD_SECONDS.skew,
      queueCacheIntervalSeconds: PERIOD_SECONDS.queueCache,
      cronWorkerIntervalSeconds: WORKER_POLL_SECONDS
    })

    const queue = ctx.schema
    await ctx.boss.createQueue(queue)
    await ctx.boss.work(queue, { pollingIntervalSeconds: WORKER_POLL_SECONDS }, async () => {})
    const spy = ctx.boss.getSpy(queue)

    const id = await ctx.boss.send(queue)
    await spy.waitForJobWithId(id!, 'completed')

    for (const name of CHAINED) {
      expect(clock.armed.setTimeout, `${name} timer`).toContain(PERIOD_SECONDS[name] * 1000)
    }

    for (const name of REPEATING) {
      expect(clock.armed.setInterval, `${name} timer`).toContain(PERIOD_SECONDS[name] * 1000)
    }

    const periods = new Set(Object.values(PERIOD_SECONDS).map(seconds => seconds * 1000))
    const pollDelays = clock.armed.setTimeout.filter(ms => !periods.has(ms) && ms > 0 && ms <= WORKER_POLL_SECONDS * 1000)

    expect(pollDelays.length, 'a worker polled on a delay taken from the clock').toBeGreaterThan(0)

    expect(clock.reads, 'the runtime read the time from the clock').toBeGreaterThan(0)
    expect(clock.live.size, 'timers are outstanding while the instance runs').toBeGreaterThan(0)

    await ctx.boss.stop({ graceful: true })
    ctx.boss = undefined

    expect(clock.live.size, 'every timer was released on stop').toBe(0)
  })
})
