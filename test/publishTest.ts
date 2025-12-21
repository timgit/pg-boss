import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('pubsub', function () {
  it('should fail with no arguments', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await assert.rejects(async () => {
      // @ts-ignore
      await testContext.boss.publish()
    })
  })

  it('should accept single string argument', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)
    await testContext.boss.publish(testContext.schema)
  })

  it('should not send to the same named queue', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const message = 'hi'

    await testContext.boss.publish(testContext.schema, { message })

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert(!job)
  })

  it('should use subscriptions to map to a single queue', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const event = 'event'
    const message = 'hi'

    await testContext.boss.subscribe(event, testContext.schema)
    await testContext.boss.publish(event, { message })

    const [job] = await testContext.boss.fetch<{ message: string }>(testContext.schema)

    assert.strictEqual(message, job.data.message)
  })

  it('should use subscriptions to map to more than one queue', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    interface Message {
      message: string
    }

    const queue1 = 'subqueue1'
    const queue2 = 'subqueue2'

    await testContext.boss.createQueue(queue1)
    await testContext.boss.createQueue(queue2)

    const event = 'event'
    const message = 'hi'

    await testContext.boss.subscribe(event, queue1)
    await testContext.boss.subscribe(event, queue2)
    await testContext.boss.publish(event, { message })

    const [job1] = await testContext.boss.fetch<Message>(queue1)
    const [job2] = await testContext.boss.fetch<Message>(queue2)

    assert.strictEqual(message, job1.data.message)
    assert.strictEqual(message, job2.data.message)
  })
})

it('should fail if unsubscribe is called without args', async function () {
  testContext.boss = await helper.start(testContext.bossConfig)
  await assert.rejects(async () => {
    // @ts-ignore
    await testContext.boss.unsubscribe()
  })
})

it('should fail if unsubscribe is called without both args', async function () {
  testContext.boss = await helper.start(testContext.bossConfig)
  await assert.rejects(async () => {
    // @ts-ignore
    await testContext.boss.unsubscribe('foo')
  })
})

it('unsubscribe works', async function () {
  testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

  const event = 'foo'

  const queue1 = 'queue1'
  const queue2 = 'queue2'

  await testContext.boss.createQueue(queue1)
  await testContext.boss.createQueue(queue2)

  await testContext.boss.subscribe(event, queue1)
  await testContext.boss.subscribe(event, queue2)

  await testContext.boss.publish(event)

  const [job1] = await testContext.boss.fetch(queue1)

  assert(job1)

  const [job2] = await testContext.boss.fetch(queue2)

  assert(job2)

  await testContext.boss.unsubscribe(event, queue2)

  await testContext.boss.publish(event)

  const [job3] = await testContext.boss.fetch(queue1)

  assert(job3)

  const [job4] = await testContext.boss.fetch(queue2)

  assert(!job4)

  await testContext.boss.unsubscribe(event, queue1)

  await testContext.boss.publish(event)

  const [job5] = await testContext.boss.fetch(queue1)
  assert(!job5)
})
