import { expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('insert', function () {
  it('should create jobs from an array', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const input = [{}, {}, {}]

    await testContext.boss.insert(testContext.schema, input)

    const { queuedCount } = await testContext.boss.getQueueStats(testContext.schema)

    expect(queuedCount).toBe(3)
  })

  it('should create jobs from an array with all properties', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const deadLetter = `${testContext.schema}_dlq`
    await testContext.boss.createQueue(deadLetter)
    await testContext.boss.updateQueue(testContext.schema, { deadLetter })

    const input = {
      id: randomUUID(),
      priority: 1,
      data: { some: 'data' },
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 3,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      deleteAfterSeconds: 60,
      singletonKey: '123',
      retentionSeconds: 60
    }

    const keepUntil = new Date(new Date(input.startAfter).getTime() + (input.retentionSeconds * 1000)).toISOString()

    await testContext.boss.insert(testContext.schema, [input])

    const job = await testContext.boss.getJobById(testContext.schema, input.id)

    expect(job).toBeTruthy()

    expect(job!.id).toBe(input.id)
    expect(job!.priority).toBe(input.priority)
    expect(JSON.stringify(job!.data)).toBe(JSON.stringify(input.data))
    expect(job!.retryLimit).toBe(input.retryLimit)
    expect(job!.retryDelay).toBe(input.retryDelay)
    expect(job!.retryBackoff).toBe(input.retryBackoff)
    expect(job!.retryDelayMax).toBe(input.retryDelayMax)
    expect(new Date(job!.startAfter).toISOString()).toBe(input.startAfter)
    expect(job!.expireInSeconds).toBe(input.expireInSeconds)
    expect(job!.deleteAfterSeconds).toBe(input.deleteAfterSeconds)
    expect(job!.singletonKey).toBe(input.singletonKey)
    expect(new Date(job!.keepUntil).toISOString()).toBe(keepUntil)
  })

  it('should create jobs from an array with all properties and custom connection', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const deadLetter = `${testContext.schema}_dlq`
    await testContext.boss.createQueue(deadLetter)
    await testContext.boss.updateQueue(testContext.schema, { deadLetter })

    const input = {
      id: randomUUID(),
      priority: 1,
      data: { some: 'data' },
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 3,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      deleteAfterSeconds: 45,
      singletonKey: '123',
      retentionSeconds: 60
    }

    const keepUntil = new Date(new Date(input.startAfter).getTime() + (input.retentionSeconds * 1000)).toISOString()

    let called = false
    const db = await helper.getDb()
    const options = {
      db: {
        // @ts-ignore
        async executeSql (sql, values) {
          called = true
          // @ts-ignore
          return db.pool.query(sql, values)
        }
      }
    }

    await testContext.boss.insert(testContext.schema, [input], options)

    const job = await testContext.boss.getJobById(testContext.schema, input.id)

    expect(job).toBeTruthy()

    expect(job!.id).toBe(input.id)
    expect(job!.priority).toBe(input.priority)
    expect(JSON.stringify(job!.data)).toBe(JSON.stringify(input.data))
    expect(job!.retryLimit).toBe(input.retryLimit)
    expect(job!.retryDelay).toBe(input.retryDelay)
    expect(job!.retryBackoff).toBe(input.retryBackoff)
    expect(job!.retryDelayMax).toBe(input.retryDelayMax)
    expect(new Date(job!.startAfter).toISOString()).toBe(input.startAfter)
    expect(job!.expireInSeconds).toBe(input.expireInSeconds)
    expect(job!.deleteAfterSeconds).toBe(input.deleteAfterSeconds)
    expect(job!.singletonKey).toBe(input.singletonKey)
    expect(new Date(job!.keepUntil).toISOString()).toBe(keepUntil)
    expect(called).toBe(true)
  })
})
