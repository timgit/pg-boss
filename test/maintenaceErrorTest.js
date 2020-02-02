const helper = require('./testHelper')
const Boss = require('../')
describe('maintenance error handling', function () {
  this.timeout(10000)

  this.beforeEach(() => helper.init())

  it('maintenance error handling works', function (finished) {
    const config = {
      monitorStateIntervalMinutes: 1,
      maintenanceIntervalSeconds: 1,
      __test_throw_on_maint__: true
    }

    const boss = new Boss(helper.getConfig(config))
    boss.on('error', () => {
      boss.stop().then(() => finished())
    })
    boss.start()
  })

  it('state monitoring error handling works', function (finished) {
    const config = {
      monitorStateIntervalSeconds: 1,
      maintenanceIntervalMinutes: 1,
      __test_throw_on_monitor__: true
    }

    const boss = new Boss(helper.getConfig(config))
    boss.on('error', () => {
      boss.stop().then(finished)
    })
    boss.start()
  })
})
