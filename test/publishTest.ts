import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('pubsub', function () {
  it('should fail with no arguments', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.publish()
    }).rejects.toThrow()
  })

  it('should accept single string argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.publish(ctx.schema)
  })

  it('should not send to the same named queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const message = 'hi'

    await ctx.boss.publish(ctx.schema, { message })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()
  })

  it('should use subscriptions to map to a single queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const event = 'event'
    const message = 'hi'

    await ctx.boss.subscribe(event, ctx.schema)
    await ctx.boss.publish(event, { message })

    const [job] = await ctx.boss.fetch<{ message: string }>(ctx.schema)

    expect(job.data.message).toBe(message)
  })

  it('should use subscriptions to map to more than one queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    interface Message {
      message: string
    }

    const queue1 = 'subqueue1'
    const queue2 = 'subqueue2'

    await ctx.boss.createQueue(queue1)
    await ctx.boss.createQueue(queue2)

    const event = 'event'
    const message = 'hi'

    await ctx.boss.subscribe(event, queue1)
    await ctx.boss.subscribe(event, queue2)
    await ctx.boss.publish(event, { message })

    const [job1] = await ctx.boss.fetch<Message>(queue1)
    const [job2] = await ctx.boss.fetch<Message>(queue2)

    expect(job1.data.message).toBe(message)
    expect(job2.data.message).toBe(message)
  })
})

it('should fail if unsubscribe is called without args', async function () {
  ctx.boss = await helper.start(ctx.bossConfig)
  await expect(async () => {
    // @ts-ignore
    await ctx.boss.unsubscribe()
  }).rejects.toThrow()
})

it('should fail if unsubscribe is called without both args', async function () {
  ctx.boss = await helper.start(ctx.bossConfig)
  await expect(async () => {
    // @ts-ignore
    await ctx.boss.unsubscribe('foo')
  }).rejects.toThrow()
})

it('unsubscribe works', async function () {
  ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

  const event = 'foo'

  const queue1 = 'queue1'
  const queue2 = 'queue2'

  await ctx.boss.createQueue(queue1)
  await ctx.boss.createQueue(queue2)

  await ctx.boss.subscribe(event, queue1)
  await ctx.boss.subscribe(event, queue2)

  await ctx.boss.publish(event)

  const [job1] = await ctx.boss.fetch(queue1)

  expect(job1).toBeTruthy()

  const [job2] = await ctx.boss.fetch(queue2)

  expect(job2).toBeTruthy()

  await ctx.boss.unsubscribe(event, queue2)

  await ctx.boss.publish(event)

  const [job3] = await ctx.boss.fetch(queue1)

  expect(job3).toBeTruthy()

  const [job4] = await ctx.boss.fetch(queue2)

  expect(job4).toBeFalsy()

  await ctx.boss.unsubscribe(event, queue1)

  await ctx.boss.publish(event)

  const [job5] = await ctx.boss.fetch(queue1)
  expect(job5).toBeFalsy()
})
