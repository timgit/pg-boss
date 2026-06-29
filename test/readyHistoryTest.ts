import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import { ctx } from './hooks.ts'
import * as migrationStore from '../src/migrationStore.ts'
import { READY_HISTORY_SIZE } from '../src/plans.ts'

describe('readyHistory', function () {
  it('maintains a newest-first sliding window of ready counts per monitor cycle, capped at the window size', async function () {
    const queue = `q${randomUUID().replaceAll('-', '')}`
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.createQueue(queue)

    const db = await helper.getDb()
    const readHistory = async (): Promise<number[]> => {
      const { rows } = await db.executeSql(
        `SELECT ready_history FROM ${ctx.schema}.queue WHERE name = $1`, [queue])
      return rows[0].ready_history
    }
    // The monitor only runs for queues whose monitor_on is older than monitorIntervalSeconds; age it
    // so each manual supervise() actually performs a cycle.
    const makeDue = () => db.executeSql(
      `UPDATE ${ctx.schema}.queue SET monitor_on = now() - interval '1 day' WHERE name = $1`, [queue])

    // Empty queue: the first monitor cycle records a single 0.
    await ctx.boss.supervise(queue)
    expect(await readHistory()).toEqual([0])

    // Two queued jobs → the next cycle prepends the newest sample (2 ready), newest-first.
    await ctx.boss.send(queue)
    await ctx.boss.send(queue)
    await makeDue()
    await ctx.boss.supervise(queue)
    expect(await readHistory()).toEqual([2, 0])

    // Capping: pre-seed an over-full window (size + 10), run one more cycle, and confirm it caps at
    // READY_HISTORY_SIZE with the newest sample prepended and the oldest dropped.
    const hi = 1000 + READY_HISTORY_SIZE + 9
    await db.executeSql(
      `UPDATE ${ctx.schema}.queue
         SET ready_history = (SELECT array_agg(g ORDER BY g) FROM generate_series(1000, ${hi}) AS g),
             monitor_on = now() - interval '1 day'
       WHERE name = $1`, [queue])
    await ctx.boss.supervise(queue)

    const capped = await readHistory()
    expect(capped).toHaveLength(READY_HISTORY_SIZE)
    expect(capped[0]).toBe(2)                                      // newest sample prepended (still 2 ready)
    expect(capped[1]).toBe(1000)                                   // previous window retained, newest-first
    expect(capped[READY_HISTORY_SIZE - 1]).toBe(1000 + READY_HISTORY_SIZE - 2) // oldest kept; the rest dropped

    await db.close()
  })

  it('is added by the v35 migration and dropped on rollback', function () {
    const migration = migrationStore.getAll('pgboss').find(m => m.version === 35)
    expect(migration).toBeTruthy()
    expect(migration!.install.join('\n')).toContain('ADD COLUMN ready_history int[]')
    expect((migration!.uninstall ?? []).join('\n')).toContain('DROP COLUMN ready_history')
  })
})
