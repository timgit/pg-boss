import { strictEqual } from 'node:assert'
import { PgBoss } from '../src/index.ts'
import { delay } from '../src/tools.ts'

describe('background processing error handling', function () {
  it('maintenance error handling works', async function () {
    const defaults = {
      superviseIntervalSeconds: 1,
      supervise: true,
      __test__throw_maint: 'my maintenance error'
    }

    const config = { ...this.bossConfig, ...defaults }
    this.boss = new PgBoss(config)

    let errorCount = 0

    this.boss.once('error', (error) => {
      strictEqual(error.message, config.__test__throw_maint)
      errorCount++
    })

    await this.boss.start()

    await delay(3000)

    strictEqual(errorCount, 1)
  })
})
