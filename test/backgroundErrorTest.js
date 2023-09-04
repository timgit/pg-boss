const assert = require('assert')
const PgBoss = require('../')
const delay = require('delay')

describe('background processing error handling', function () {
  it('maintenance error handling works', async function () {
    const defaults = {
      maintenanceIntervalSeconds: 1,
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

  it('state monitoring error handling works', async function () {
    const defaults = {
      monitorStateIntervalSeconds: 1,
      supervise: true,
      __test__throw_monitor: 'my monitor error'
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = new PgBoss(config)

    let errorCount = 0

    boss.once('error', (error) => {
      assert.strictEqual(error.message, config.__test__throw_monitor)
      errorCount++
    })

    await boss.start()

    await delay(3000)

    assert.strictEqual(errorCount, 1)
  })
})
