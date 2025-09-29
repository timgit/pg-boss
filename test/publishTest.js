import assert, { strictEqual } from 'node:assert'
import { start } from './testHelper.js'

describe('pubsub', () => {
  it('should fail with no arguments', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))

    try {
      await boss.publish()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for data', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    try {
      await boss.publish(queue, () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for options', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    try {
      await boss.publish(queue, 'data', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should accept single string argument', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema
    await boss.publish(queue)
  })

  it('should accept job object argument with only name', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema
    await boss.publish(queue)
  })

  it('should not send to the same named queue', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const message = 'hi'

    await boss.publish(queue, { message })

    const [job] = await boss.fetch(queue)

    assert(!job)
  })

  it('should use subscriptions to map to a single queue', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const event = 'event'
    const message = 'hi'

    await boss.subscribe(event, queue)
    await boss.publish(event, { message })

    const [job] = await boss.fetch(queue)

    strictEqual(message, job.data.message)
  })

  it('should use subscriptions to map to more than one queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))

    const queue1 = 'subqueue1'
    const queue2 = 'subqueue2'

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    const event = 'event'
    const message = 'hi'

    await boss.subscribe(event, queue1)
    await boss.subscribe(event, queue2)
    await boss.publish(event, { message })

    const [job1] = await boss.fetch(queue1)
    const [job2] = await boss.fetch(queue2)

    strictEqual(message, job1.data.message)
    strictEqual(message, job2.data.message)
  })
})

it('should fail if unsubscribe is called without args', async function () {
  const boss = (this.test.boss = await start(this.test.bossConfig))

  try {
    await boss.unsubscribe()
    assert(false)
  } catch (err) {
    assert(err)
  }
})

it('should fail if unsubscribe is called without both args', async function () {
  const boss = (this.test.boss = await start(this.test.bossConfig))

  try {
    await boss.unsubscribe('foo')
    assert(false)
  } catch (err) {
    assert(err)
  }
})

it('unsubscribe works', async function () {
  const boss = (this.test.boss = await start({
    ...this.test.bossConfig,
    noDefault: true
  }))

  const event = 'foo'

  const queue1 = 'queue1'
  const queue2 = 'queue2'

  await boss.createQueue(queue1)
  await boss.createQueue(queue2)

  await boss.subscribe(event, queue1)
  await boss.subscribe(event, queue2)

  await boss.publish(event)

  const [job1] = await boss.fetch(queue1)

  assert(job1)

  const [job2] = await boss.fetch(queue2)

  assert(job2)

  await boss.unsubscribe(event, queue2)

  await boss.publish(event)

  const [job3] = await boss.fetch(queue1)

  assert(job3)

  const [job4] = await boss.fetch(queue2)

  assert(!job4)

  await boss.unsubscribe(event, queue1)

  await boss.publish(event)

  const [job5] = await boss.fetch(queue1)
  assert(!job5)
})
