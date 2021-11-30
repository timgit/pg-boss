const assert = require('assert')
const helper = require('./testHelper')

describe('pubsub', function () {
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
      await boss.publish('event', 'data', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should accept single string argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendNameOnly'
    await boss.publish(queue)
  })

  it('should accept job object argument with only name', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendqueueOnly'
    await boss.publish(queue)
  })

  it('should not send to the same named queue', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendqueueAndData'
    const message = 'hi'

    await boss.publish(queue, { message })

    const job = await boss.fetch(queue)

    assert.strictEqual(job, null)
  })

  it('should use subscriptions to map to a single queue', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'sendqueueAndData'
    const event = 'event'
    const message = 'hi'

    await boss.subscribe(event, queue)
    await boss.publish(event, { message })

    const job = await boss.fetch(queue)

    assert.strictEqual(message, job.data.message)
  })

  it('should use subscriptions to map to more than one queue', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue1 = 'queue1'
    const queue2 = 'queue2'
    const event = 'event'
    const message = 'hi'

    await boss.subscribe(event, queue1)
    await boss.subscribe(event, queue2)
    await boss.publish(event, { message })

    const job1 = await boss.fetch(queue1)
    const job2 = await boss.fetch(queue2)

    assert.strictEqual(message, job1.data.message)
    assert.strictEqual(message, job2.data.message)
  })
})

it('should fail if unsubscribe is called without args', async function () {
  const boss = this.test.boss = await helper.start(this.test.bossConfig)

  try {
    await boss.unsubscribe()
    assert(false)
  } catch (err) {
    assert(err)
  }
})

it('should fail if unsubscribe is called without both args', async function () {
  const boss = this.test.boss = await helper.start(this.test.bossConfig)

  try {
    await boss.unsubscribe('foo')
    assert(false)
  } catch (err) {
    assert(err)
  }
})

it('unsubscribe works', async function () {
  const boss = this.test.boss = await helper.start(this.test.bossConfig)

  const event = 'foo'
  const queue1 = 'queue1'
  const queue2 = 'queue2'

  await boss.subscribe(event, queue1)
  await boss.subscribe(event, queue2)

  await boss.publish(event)

  assert(await boss.fetch(queue1))
  assert(await boss.fetch(queue2))

  await boss.unsubscribe(event, queue2)

  await boss.publish(event)

  assert(await boss.fetch(queue1))

  assert.strictEqual(null, await boss.fetch(queue2))

  await boss.publish(event)

  assert.strictEqual(null, await boss.fetch(queue1))
})
