const helper = require('./testHelper')

describe('ops', function () {
  this.timeout(10000)

  let boss

  before(async () => {
    boss = await helper.start()
    await boss.stop()
  })

  it('should expire manually', async function () {
    await boss.connect()
    await boss.expire()
  })

  it('should archive manually', async function () {
    await boss.connect()
    await boss.archive()
  })

  it('should purge the archive manually', async function () {
    await boss.connect()
    await boss.purge()
  })
})
