import { describe, it, expect } from './harness.ts'
import { BunBoss } from '../src/index.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('background processing error handling', function () {
  it('maintenance error handling works', async function () {
    const defaults = {
      superviseIntervalSeconds: 1,
      supervise: true,
      __test__throw_maint: 'my maintenance error'
    }

    const config = { ...ctx.bossConfig, ...defaults }
    ctx.boss = new BunBoss(config)

    let errorCount = 0

    ctx.boss.on('error', (error) => {
      expect(error.message).toBe(config.__test__throw_maint)
      errorCount++
    })

    await ctx.boss.start()

    await delay(3000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })
})
