const PgBoss = require('../')

describe('background processing error handling', function () {
  it('maintenance error handling works', async function () {
    const defaults = {
      monitorStateIntervalMinutes: 1,
      maintenanceIntervalSeconds: 1,
      noScheduling: true,
      __test__throw_maint: true
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = new PgBoss(config)

    return new Promise((resolve) => {
      let resolved = false

      boss.on('error', () => {
        if (!resolved) {
          resolved = true
          resolve()
        }
      })

      boss.start().then(() => {})
    })
  })

  it('state monitoring error handling works', async function () {
    const defaults = {
      monitorStateIntervalSeconds: 2,
      maintenanceIntervalMinutes: 1,
      noScheduling: true,
      __test__throw_monitor: true
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = this.test.boss = new PgBoss(config)

    return new Promise((resolve) => {
      let resolved = false

      boss.on('error', () => {
        if (!resolved) {
          resolved = true
          resolve()
        }
      })

      boss.start().then(() => {})
    })
  })

  it('clock monitoring error handling works', async function () {
    const config = { ...this.test.bossConfig, __test__throw_clock_monitoring: true }
    const boss = this.test.boss = new PgBoss(config)

    return new Promise((resolve) => {
      let resolved = false

      boss.on('error', () => {
        if (!resolved) {
          resolved = true
          resolve()
        }
      })

      boss.start().then(() => {})
    })
  })
})
