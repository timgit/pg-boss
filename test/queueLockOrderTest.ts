import { expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import { TestClock } from '../src/index.ts'
import type { PgBoss } from '../src/index.ts'

// Several instances supervising one schema claim and update the same queue rows. Unless every
// statement that writes several queue rows locks them in one order, a claim on one instance can
// collide with another instance's claim or stats update and Postgres aborts one of them with 40P01.

helper.describeMultiConnectionOnly('queue row lock order', function () {
  it('does not deadlock when several instances supervise the same queues', async function () {
    const instanceCount = 6
    const queueCount = 100
    const durationMs = 3000

    const clock = new TestClock()
    const config = {
      ...ctx.bossConfig,
      clock,
      supervise: false,
      schedule: false,
      monitorIntervalSeconds: 1,
      maintenanceIntervalSeconds: 1,
      noDefault: true
    }

    ctx.boss = await helper.start(config)

    for (let i = 0; i < queueCount; i++) {
      await ctx.boss.createQueue(`q${i}`)
    }

    const others: PgBoss[] = []
    for (let i = 1; i < instanceCount; i++) {
      others.push(await helper.start(config))
    }

    const deadline = Date.now() + durationMs
    const deadlocks: string[] = []

    // Moving the clock past both intervals makes every queue due again, and the instances run
    // unsynchronized, so one instance's claim can land while another is inside its pass.
    async function advanceClock () {
      while (Date.now() < deadline) {
        await clock.setTime(clock.now() + 2000)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }

    async function superviseLoop (boss: PgBoss) {
      while (Date.now() < deadline) {
        try {
          await boss.supervise()
        } catch (err: any) {
          if (err.code !== '40P01') throw err
          deadlocks.push(err.message)
        }
      }
    }

    try {
      await Promise.all([advanceClock(), ...[ctx.boss, ...others].map(superviseLoop)])
    } finally {
      await Promise.all(others.map(boss => boss.stop({ timeout: 2000 })))
    }

    expect(deadlocks).toEqual([])
  })
})
