const PgBoss = require('../')

describe('background processing error handling', function () {
  it('maintenance error handling works', function (done) {
    const defaults = {
      monitorStateIntervalMinutes: 1,
      maintenanceIntervalSeconds: 1,
      __test__throw_maint: true
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = new PgBoss(config)

    boss.on('error', async () => {
      boss.removeAllListeners()
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
    const boss = this.test.boss = new PgBoss(config)

    boss.on('error', async () => {
      boss.removeAllListeners()
      done()
    })

    boss.start()
  })

  it('clock monitoring error handling works', function (done) {
    const config = { ...this.test.bossConfig, __test__throw_clock_monitoring: true }
    const boss = this.test.boss = new PgBoss(config)

    boss.on('error', async () => {
      boss.removeAllListeners()
      done()
    })

    boss.start()
  })
})
