const helper = require('./testHelper')

describe('ops', function () {
  const defaults = {
    noSupervisor: true
  }

  it('should expire manually', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.expire()
  })

  it('should archive manually', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.archive()
  })

  it('should purge the archive manually', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.purge()
  })
})
