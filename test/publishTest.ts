import assert from 'node:assert'
import * as helper from './testHelper.ts'

describe('pubsub', function () {
  it('should fail with no arguments', async function () {
    this.boss = await helper.start(this.bossConfig)
    await assert.rejects(async () => {
      await this.boss.publish()
    })
  })

  it('should accept single string argument', async function () {
    this.boss = await helper.start(this.bossConfig)
    await this.boss.publish(this.schema)
  })

  it('should not send to the same named queue', async function () {
    this.boss = await helper.start(this.bossConfig)

    const message = 'hi'

    await this.boss.publish(this.schema, { message })

    const [job] = await this.boss.fetch(this.schema)

    assert(!job)
  })

  it('should use subscriptions to map to a single queue', async function () {
    this.boss = await helper.start(this.bossConfig)

    const event = 'event'
    const message = 'hi'

    await this.boss.subscribe(event, this.schema)
    await this.boss.publish(event, { message })

    const [job] = await this.boss.fetch(this.schema)

    assert.strictEqual(message, job.data.message)
  })

  it('should use subscriptions to map to more than one queue', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    const queue1 = 'subqueue1'
    const queue2 = 'subqueue2'

    await this.boss.createQueue(queue1)
    await this.boss.createQueue(queue2)

    const event = 'event'
    const message = 'hi'

    await this.boss.subscribe(event, queue1)
    await this.boss.subscribe(event, queue2)
    await this.boss.publish(event, { message })

    const [job1] = await this.boss.fetch(queue1)
    const [job2] = await this.boss.fetch(queue2)

    assert.strictEqual(message, job1.data.message)
    assert.strictEqual(message, job2.data.message)
  })
})

it('should fail if unsubscribe is called without args', async function () {
  this.boss = await helper.start(this.bossConfig)
  await assert.rejects(async () => {
    await this.boss.unsubscribe()
  })
})

it('should fail if unsubscribe is called without both args', async function () {
  this.boss = await helper.start(this.bossConfig)
  await assert.rejects(async () => {
    await this.boss.unsubscribe('foo')
  })
})

it('unsubscribe works', async function () {
  this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

  const event = 'foo'

  const queue1 = 'queue1'
  const queue2 = 'queue2'

  await this.boss.createQueue(queue1)
  await this.boss.createQueue(queue2)

  await this.boss.subscribe(event, queue1)
  await this.boss.subscribe(event, queue2)

  await this.boss.publish(event)

  const [job1] = await this.boss.fetch(queue1)

  assert(job1)

  const [job2] = await this.boss.fetch(queue2)

  assert(job2)

  await this.boss.unsubscribe(event, queue2)

  await this.boss.publish(event)

  const [job3] = await this.boss.fetch(queue1)

  assert(job3)

  const [job4] = await this.boss.fetch(queue2)

  assert(!job4)

  await this.boss.unsubscribe(event, queue1)

  await this.boss.publish(event)

  const [job5] = await this.boss.fetch(queue1)
  assert(!job5)
})
