const assert = require('assert')
const helper = require('./testHelper')

describe('publish', function () {
  it('should fail with no arguments', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.publish()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for data', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.publish('job', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for options', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.publish('job', 'data', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should accept single string argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'publishNameOnly'
    await boss.publish(queue)
  })

  it('should accept job object argument with only name', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'publishqueueOnly'
    await boss.publish({ name: queue })
  })

  it('should accept job object with name and data only', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'publishqueueAndData'
    const message = 'hi'

    await boss.publish({ name: queue, data: { message } })

    const job = await boss.fetch(queue)

    assert.strictEqual(message, job.data.message)
  })

  it('should accept job object with name and options only', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'publishqueueAndOptions'
    const options = { someCrazyOption: 'whatever' }

    await boss.publish({ name: queue, options })

    const job = await boss.fetch(queue)

    assert.strictEqual(job.data, null)
  })
})
