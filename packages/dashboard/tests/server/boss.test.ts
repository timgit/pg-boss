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

    it('stops the cached instances without breaking the next write', async () => {
      const queue = 'stop-instances'
      await createTestQueue(queue)
      await sendJob(ctx.connectionString, ctx.schema, queue, { n: 1 })

      await stopAllInstances()

      await expect(sendJob(ctx.connectionString, ctx.schema, queue, { n: 2 })).resolves.toEqual(expect.any(String))
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
