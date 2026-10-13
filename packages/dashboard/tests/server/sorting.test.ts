import { describe, it, expect } from 'vitest'
import pg from 'pg'
import { ctx, createTestQueue, updateQueueStats, insertTestWarning, insertTestBam } from './helpers'
import { getQueuePage, getSchedules, getWarnings, getBamEntries } from '~/lib/queries.server'

// A page wide enough to hold every row a test writes.
const L = 100

describe('list sorting', () => {
  describe('getQueuePage', () => {
    it('sorts by name ascending and descending', async () => {
      await createTestQueue('queue-a')
      await createTestQueue('queue-b')
      await createTestQueue('queue-c')

      const asc = (await getQueuePage(ctx.connectionString, ctx.schema, { limit: L, sort: 'name', dir: 'asc' })).rows
      const desc = (await getQueuePage(ctx.connectionString, ctx.schema, { limit: L, sort: 'name', dir: 'desc' })).rows

      expect(asc.map((q) => q.name)).toEqual(['queue-a', 'queue-b', 'queue-c'])
      expect(desc.map((q) => q.name)).toEqual(['queue-c', 'queue-b', 'queue-a'])
    })

    it('sorts by a numeric column', async () => {
      await createTestQueue('q1'); await updateQueueStats(ctx.schema, 'q1', { totalCount: 5 })
      await createTestQueue('q2'); await updateQueueStats(ctx.schema, 'q2', { totalCount: 1 })
      await createTestQueue('q3'); await updateQueueStats(ctx.schema, 'q3', { totalCount: 9 })

      const asc = (await getQueuePage(ctx.connectionString, ctx.schema, { limit: L, sort: 'total', dir: 'asc' })).rows
      expect(asc.map((q) => q.totalCount)).toEqual([1, 5, 9])
    })

    it('falls back to the default order for an unknown / unsafe sort key', async () => {
      await createTestQueue('queue-b')
      await createTestQueue('queue-a')

      const result = (await getQueuePage(ctx.connectionString, ctx.schema, {
        limit: L,
        sort: 'name); DROP TABLE pgboss.queue; --',
        dir: 'desc',
      })).rows

      // Unknown key is ignored → default name ASC, and nothing is injected.
      expect(result.map((q) => q.name)).toEqual(['queue-a', 'queue-b'])
    })
  })

  it('getSchedules sorts by key', async () => {
    await createTestQueue('sched-q')
    const pool = new pg.Pool({ connectionString: ctx.connectionString })
    await pool.query(
      `INSERT INTO ${ctx.schema}.schedule (name, key, cron, timezone) VALUES ($1,'zeta','0 * * * *','UTC'), ($1,'alpha','0 * * * *','UTC')`,
      ['sched-q'])
    await pool.end()

    const result = (await getSchedules(ctx.connectionString, ctx.schema, { limit: L, sort: 'key', dir: 'asc' })).rows
    expect(result.map((s) => s.key)).toEqual(['alpha', 'zeta'])
  })

  it('getWarnings sorts by type', async () => {
    await insertTestWarning(ctx.schema, 'slow_query', 'm1')
    await insertTestWarning(ctx.schema, 'clock_skew', 'm2')

    const asc = (await getWarnings(ctx.connectionString, ctx.schema, { limit: L, sort: 'type', dir: 'asc' })).rows
    expect(asc[0].type).toBe('clock_skew')
  })

  it('getBamEntries sorts by version', async () => {
    await insertTestBam(ctx.schema, { name: 'mig-a', version: 36 })
    await insertTestBam(ctx.schema, { name: 'mig-b', version: 34 })

    const asc = (await getBamEntries(ctx.connectionString, ctx.schema, { limit: L, sort: 'version', dir: 'asc' })).rows
    expect(asc.map((e) => e.version)).toEqual([34, 36])
  })
})
