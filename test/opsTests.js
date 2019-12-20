const helper = require('./testHelper')

describe('ops', function () {
  this.timeout(10000)

  let boss

  before(async () => {
    boss = await helper.start()
    await boss.stop()
  })

  it('should start back up after stopping', async function () {
    await boss.start()
    await boss.stop()
  })

  it('should expire manually', async function () {
    await boss.connect()
    await boss.expire()
    await boss.disconnect()
  })

  it('should archive manually', async function () {
    await boss.connect()
    await boss.archive()
    await boss.disconnect()
  })

  it('should purge the archive manually', async function () {
    await boss.connect()
    await boss.purge()
    await boss.disconnect()
  })
})
