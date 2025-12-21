import { expect } from 'vitest'
import { PgBoss } from '../src/index.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('background processing error handling', function () {
  it('maintenance error handling works', async function () {
    const defaults = {
      superviseIntervalSeconds: 1,
      supervise: true,
      __test__throw_maint: 'my maintenance error'
    }

    const config = { ...testContext.bossConfig, ...defaults }
    testContext.boss = new PgBoss(config)

    let errorCount = 0

    testContext.boss.on('error', (error) => {
      expect(error.message).toBe(config.__test__throw_maint)
      errorCount++
    })

    await testContext.boss.start()

    await delay(3000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })
})
