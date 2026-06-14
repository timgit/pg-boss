import { describe, it, expect } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('queue names with slashes', function () {
  it('should allow forward slashes in queue names', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queueName = 'webapp/user.created'
    await ctx.boss.createQueue(queueName)

    const queue = await ctx.boss.getQueue(queueName)
    expect(queue).toBeTruthy()
    expect(queue.name).toBe(queueName)
  })

  it('should allow nested paths like api/v1/users', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queueName = 'api/v1/users'
    await ctx.boss.createQueue(queueName)

    const queue = await ctx.boss.getQueue(queueName)
    expect(queue).toBeTruthy()
  })

  it('should work with send and work on slashed queue names', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queueName = 'events/user.signup'
    await ctx.boss.createQueue(queueName)

    // Test send
    await ctx.boss.send(queueName, { userId: 123 })

    // Test work/fetch
    const jobs = await ctx.boss.fetch<{ userId: number }>(queueName)
    expect(jobs.length).toEqual(1)
    expect(jobs[0].data.userId).toBe(123)
  })

  it('should still reject invalid characters', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const invalidNames = ['queue*name', 'queue$name', 'queue@name', 'queue!name']

    for (const name of invalidNames) {
      await expect(async () => {
        await ctx.boss!.createQueue(name)
      }).rejects.toThrow()
    }
  })
})
