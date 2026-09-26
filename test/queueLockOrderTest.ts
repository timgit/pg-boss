import { describe, expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as plans from '../src/plans.ts'
import * as Attorney from '../src/attorney.ts'
import type { BackendProfile } from '../src/types.ts'

// Several instances supervising one schema claim and update the same queue rows. Unless every
// statement that writes several queue rows locks them in one order, two of them can lock the same
// rows in opposite orders and Postgres aborts one with 40P01. The statements run straight from
// plans so the contention does not depend on how a clock paces supervise(): an interval of 0 keeps
// every queue due on every claim, and each call lists the queues in its own order.

function shuffled<T> (items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

describe('queue claim SKIP LOCKED', function () {
  const backends: Record<BackendProfile, boolean> = {
    postgres: true,
    cockroachdb: false,
    yugabytedb: false,
    citus: false,
    pglite: false
  }

  for (const [backend, expected] of Object.entries(backends)) {
    it(`is ${expected ? 'used' : 'not used'} on ${backend}`, function () {
      const config = Attorney.getConfig({ backend: backend as BackendProfile })
      const skipLocked = plans.queueClaimSkipLocked(config.backend, config.noSkipLocked)

      for (const claim of [plans.trySetQueueMonitorTime, plans.trySetQueueDeletionTime]) {
        const { text } = claim('pgboss', ['q'], 60, skipLocked)
        expect(text).toContain('ORDER BY name FOR NO KEY UPDATE')
        expect(text.includes('SKIP LOCKED')).toBe(expected)
      }
    })
  }

  it('is not used on postgres under the distributed test hook', function () {
    const config = Attorney.getConfig({ backend: 'postgres', __test__distributed: true })
    expect(plans.queueClaimSkipLocked(config.backend, config.noSkipLocked)).toBe(false)
  })
})

helper.describeMultiConnectionOnly('queue row lock order', function () {
  it('claims and stats updates on the same queue rows do not deadlock', async function () {
    const loops = 8
    const queueCount = 100
    const durationMs = 3000

    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false, schedule: false, noDefault: true })

    const names = Array.from({ length: queueCount }, (_, i) => `q${i}`)
    for (const name of names) {
      await ctx.boss.createQueue(name)
    }

    const queue = await ctx.boss.getQueue(names[0])
    helper.assertTruthy(queue)

    const { schema, backend, noSkipLocked, persistQueueStats } = ctx.bossConfig
    const skipLocked = plans.queueClaimSkipLocked(backend, noSkipLocked)
    const statements: Array<() => { text: string, values?: unknown[] }> = [
      () => plans.trySetQueueMonitorTime(schema, shuffled(names), 0, skipLocked),
      () => plans.trySetQueueDeletionTime(schema, shuffled(names), 0, skipLocked),
      // Without the advisory lock, so stats updates also collide with each other.
      () => ({ text: plans.cacheQueueStats(schema, queue.table, shuffled(names), true, persistQueueStats) })
    ]

    const db = await helper.getDb()
    const deadline = Date.now() + durationMs
    const deadlocks: string[] = []
    const errors: Error[] = []

    // Any other error stops every loop, so the first one is the one reported.
    async function run (offset: number) {
      for (let n = offset; Date.now() < deadline && !errors.length; n++) {
        const { text, values } = statements[n % statements.length]()
        try {
          await db.executeSql(text, values)
        } catch (err: any) {
          if (err.code === '40P01') {
            deadlocks.push(err.message)
          } else {
            errors.push(err)
          }
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: loops }, (_, i) => run(i)))
    } finally {
      await db.close()
    }

    expect(errors).toEqual([])
    expect(deadlocks).toEqual([])
  })
})
