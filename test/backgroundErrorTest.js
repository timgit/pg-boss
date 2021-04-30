const PgBoss = require('../')
const delay = require('delay')
describe('background processing error handling', function () {
  // this.retries(1)

  it('maintenance error handling works', function (done) {
    const defaults = {
      monitorStateIntervalMinutes: 1,
      maintenanceIntervalSeconds: 1,
      __test__throw_maint: true
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = new PgBoss(config)

    boss.on('error', async () => {
      boss.removeAllListeners()
      await boss.stop(this.test.bossConfig.stopOptions)
      await delay(2000)
      done()
    })

    boss.start()
  })

  it('state monitoring error handling works', function (done) {
    const defaults = {
      monitorStateIntervalSeconds: 1,
      maintenanceIntervalMinutes: 1,
      __test__throw_monitor: true
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = new PgBoss(config)

    boss.on('error', async () => {
      boss.removeAllListeners()
      await boss.stop(this.test.bossConfig.stopOptions)
      await delay(2000)
      done()
    })

    boss.start()
  })

  it('clock monitoring error handling works', function (done) {
    const config = { ...this.test.bossConfig, __test__throw_clock_monitoring: true }
    const boss = new PgBoss(config)

    boss.on('error', async () => {
      boss.removeAllListeners()
      await boss.stop(this.test.bossConfig.stopOptions)
      await delay(2000)
      done()
    })

    boss.start()
  })
})
