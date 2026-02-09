import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import type { JobsConfig } from '../src/types.ts'
import { PgBoss } from '../src/index.ts'

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
    const boss = await helper.start<{
      name: { input: { message: string }, output: {} },
    }>(ctx.bossConfig)
    ctx.boss = boss as unknown as PgBoss<JobsConfig>
    const schema = ctx.schema as 'name'

    const event = 'event'
    const message = 'hi'

    await boss.subscribe(event, schema)
    await boss.publish(event, { message })

    const [job] = await boss.fetch(schema)

    expect(job.data.message).toBe(message)
  })

  it('should use subscriptions to map to more than one queue', async function () {
    interface Message {
      message: string
    }

    const boss = await helper.start<{
      subqueue1: { input: Message, output: {} },
      subqueue2: { input: Message, output: {} },
    }>({ ...ctx.bossConfig, noDefault: true })
    ctx.boss = boss as unknown as PgBoss<JobsConfig>

    const queue1 = 'subqueue1' as const
    const queue2 = 'subqueue2' as const

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    const event = 'event'
    const message = 'hi'

    await boss.subscribe(event, queue1)
    await boss.subscribe(event, queue2)
    await boss.publish(event, { message })

    const [job1] = await boss.fetch(queue1)
    const [job2] = await boss.fetch(queue2)

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
