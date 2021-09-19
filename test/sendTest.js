const assert = require('assert')
const helper = require('./testHelper')

describe('send', function () {
  it('should fail with no arguments', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.send()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for data', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.send('job', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for options', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.send('job', 'data', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should accept single string argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendNameOnly'
    await boss.send(queue)
  })

  it('should accept job object argument with only name', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendqueueOnly'
    await boss.send({ name: queue })
  })

  it('should accept job object with name and data only', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendqueueAndData'
    const message = 'hi'

    await boss.send({ name: queue, data: { message } })

    const job = await boss.fetch(queue)

    assert.strictEqual(message, job.data.message)
  })

  it('should accept job object with name and options only', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendqueueAndOptions'
    const options = { someCrazyOption: 'whatever' }

    await boss.send({ name: queue, options })

    const job = await boss.fetch(queue)

    assert.strictEqual(job.data, null)
  })
})
