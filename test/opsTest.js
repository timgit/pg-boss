const assert = require('assert')
const helper = require('./testHelper')
const { v4: uuid } = require('uuid')
const delay = require('delay')

describe('ops', function () {
  const defaults = {
    noSupervisor: true,
    noScheduling: true
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

  it('stop should re-emit stoppped if already stopped', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const stopPromise1 = new Promise(resolve => boss.once('stopped', resolve))

    await boss.stop({ timeout: 1 })

    await stopPromise1

    const stopPromise2 = new Promise(resolve => boss.once('stopped', resolve))

    await boss.stop({ timeout: 1 })

    await stopPromise2
  })

  it('should emit error in subscription', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults, __test__throw_subscription: true })
    const queue = this.test.bossConfig.schema

    await boss.publish(queue)
    await boss.subscribe(queue, () => {})

    await new Promise(resolve => boss.once('error', resolve))
  })

  it('should return null from getJobById if not found', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const jobId = await boss.getJobById(uuid())

    assert.strictEqual(jobId, null)
  })

  it('should force stop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    await boss.stop({ graceful: false })
  })

  it('should emit error during graceful stop if subscriptions busy', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults, __test__throw_stop: true })
    const queue = this.test.bossConfig.schema

    await boss.publish(queue)
    await boss.subscribe(queue, () => delay(2000))

    await delay(500)

    await boss.stop({ timeout: 5000 })

    await new Promise(resolve => boss.on('error', resolve))
  })

  it('should throw error during graceful stop if no subscriptions are busy', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults, __test__throw_stop: true })

    try {
      await boss.stop({ timeout: 1 })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })
})
