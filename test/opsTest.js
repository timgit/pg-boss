const helper = require('./testHelper')

describe('ops', function () {
  const defaults = {
    noSupervisor: true
  }

  it('should start back up after stopping', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.stop(this.test.bossConfig.stopOptions)
    await boss.start()
    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should expire manually', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.expire()
    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should archive manually', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.archive()
    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should purge the archive manually', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.purge()
    await boss.stop(this.test.bossConfig.stopOptions)
  })
})
