const assert = require('node:assert')
const PgBoss = require('../src/index.js').default
const { delay } = require('../src/tools')

describe('background processing error handling', function () {
  it('maintenance error handling works', async function () {
    const defaults = {
      superviseIntervalSeconds: 1,
      supervise: true,
      __test__throw_maint: 'my maintenance error'
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = new PgBoss(config)

    let errorCount = 0

    boss.once('error', (error) => {
      assert.strictEqual(error.message, config.__test__throw_maint)
      errorCount++
    })

    await boss.start()

    await delay(3000)

    assert.strictEqual(errorCount, 1)
  })

  it('shutdown error handling works', async function () {
    const config = {
      ...this.test.bossConfig,
      __test__throw_shutdown: 'shutdown error'
    }

    const boss = this.test.boss = new PgBoss(config)

    let errorCount = 0

    boss.once('error', (error) => {
      assert.strictEqual(error.message, config.__test__throw_shutdown)
      errorCount++
    })

    await boss.start()

    await boss.stop({ wait: false })

    await delay(1000)

    assert.strictEqual(errorCount, 1)
  })

  it('shutdown monitoring error handling works', async function () {
    const config = {
      ...this.test.bossConfig,
      __test__throw_stop_monitor: 'monitor error'
    }

    const boss = this.test.boss = new PgBoss(config)

    await boss.start()

    try {
      await boss.stop({ wait: false })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })
})
