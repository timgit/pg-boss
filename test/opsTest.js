const helper = require('./testHelper')

describe('ops', function () {
  const defaults = {
    noSupervisor: true
  }

  it('should start back up after stopping', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.stop()
    await boss.start()
    await boss.stop()
  })

  it('should expire manually', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.stop()
    await boss.connect()
    await boss.expire()
    await boss.disconnect()
  })

  it('should archive manually', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.stop()
    await boss.connect()
    await boss.archive()
    await boss.disconnect()
  })

  it('should purge the archive manually', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.stop()
    await boss.connect()
    await boss.purge()
    await boss.disconnect()
  })
})
