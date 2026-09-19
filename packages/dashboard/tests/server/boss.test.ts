import { describe, it, expect, vi, afterEach } from 'vitest'
import { PgBoss } from 'pg-boss'
import { ctx, createTestQueue } from './helpers'
import { sendJob, stopAllInstances } from '~/lib/boss.server'

describe('boss.server', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('stopAllInstances', () => {
    it('resolves when no instance was ever started', async () => {
      await expect(stopAllInstances()).resolves.toBeUndefined()
    })

    /**
     * Asserts that `stop()` was reached on the instance that was started.
     *
     * The obvious test — send, stop, send again, expect the second send to work
     * — passes whether or not anything was stopped, because a cleared cache and
     * an untouched one both serve the next write. It also pins the wrong thing:
     * the reason to stop these is that `Manager`'s intervals hold the event loop
     * open, and a write succeeding afterwards says nothing about that.
     *
     * Spying on the prototype is the smallest observable that fails when the
     * body of `stopAllInstances` does nothing. The instance itself is not
     * reachable from here — `getInstance` is deliberately not exported — and the
     * alternatives are worse: counting timers through
     * `process.getActiveResourcesInfo()` picks up whatever else the suite is
     * doing, and counting backends in `pg_stat_activity` races the pool's own
     * teardown.
     */
    it('stops every instance it started', async () => {
      const queue = 'stop-instances'
      await createTestQueue(queue)

      const stop = vi.spyOn(PgBoss.prototype, 'stop')

      try {
        await sendJob(ctx.connectionString, ctx.schema, queue, { n: 1 })
        expect(stop).not.toHaveBeenCalled()

        await stopAllInstances()

        expect(stop).toHaveBeenCalledTimes(1)
        expect(stop).toHaveBeenCalledWith(expect.objectContaining({ graceful: false }))
      } finally {
        stop.mockRestore()
      }
    })

    it('leaves the next write working, on a fresh instance', async () => {
      const queue = 'stop-instances-reopen'
      await createTestQueue(queue)
      await sendJob(ctx.connectionString, ctx.schema, queue, { n: 1 })

      await stopAllInstances()

      await expect(sendJob(ctx.connectionString, ctx.schema, queue, { n: 2 }))
        .resolves.toEqual(expect.any(String))

      await stopAllInstances()
    })

    it('listens for errors on every instance, so a dropped connection cannot take the process down', async () => {
      const on = vi.spyOn(PgBoss.prototype, 'on')
      const queue = 'error-listener'
      await createTestQueue(queue)

      await sendJob(ctx.connectionString, ctx.schema, queue, {})

      expect(on).toHaveBeenCalledWith('error', expect.any(Function))
      await stopAllInstances()
    })

    it('stops an instance whose start failed: it already opened a pool', async () => {
      const stop = vi.spyOn(PgBoss.prototype, 'stop')

      await expect(sendJob(ctx.connectionString, 'schema_that_does_not_exist', 'q', {})).rejects.toThrow()

      expect(stop).toHaveBeenCalled()
    })

    it('is what an embedding host reaches through close()', () => {
      const store = globalThis as unknown as Record<symbol, unknown>

      expect(store[Symbol.for('pgboss.dashboard.stopAllInstances')]).toBe(stopAllInstances)
    })
  })
})
