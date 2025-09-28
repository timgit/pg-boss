import { strictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { getDb, start } from './testHelper.js'

describe('insert', () => {
  it('should create jobs from an array with name only', async function () {
    const boss = (this.test.boss = await start(this.test.bossConfig))
    const queue = this.test.bossConfig.schema

    const input = [{ name: queue }, { name: queue }, { name: queue }]

    await boss.insert(queue, input)

    const { queuedCount } = await boss.getQueueStats(queue)

    strictEqual(queuedCount, 3)
  })

  it('should create jobs from an array with all properties', async function () {
    const boss = (this.test.boss = await start(this.test.bossConfig))
    const queue = this.test.bossConfig.schema

    const deadLetter = `${queue}_dlq`
    await boss.createQueue(deadLetter)
    await boss.updateQueue(queue, { deadLetter })

    const input = {
      id: randomUUID(),
      name: queue,
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
      keepUntil: new Date().toISOString()
    }

    await boss.insert(queue, [input])

    const job = await boss.getJobById(queue, input.id)

    strictEqual(
      job.id,
      input.id,
      `id input ${input.id} didn't match job ${job.id}`
    )
    strictEqual(
      job.name,
      input.name,
      `name input ${input.name} didn't match job ${job.name}`
    )
    strictEqual(
      job.priority,
      input.priority,
      `priority input ${input.priority} didn't match job ${job.priority}`
    )
    strictEqual(
      JSON.stringify(job.data),
      JSON.stringify(input.data),
      `data input ${input.data} didn't match job ${job.data}`
    )
    strictEqual(
      job.retryLimit,
      input.retryLimit,
      `retryLimit input ${input.retryLimit} didn't match job ${job.retryLimit}`
    )
    strictEqual(
      job.retryDelay,
      input.retryDelay,
      `retryDelay input ${input.retryDelay} didn't match job ${job.retryDelay}`
    )
    strictEqual(
      job.retryBackoff,
      input.retryBackoff,
      `retryBackoff input ${input.retryBackoff} didn't match job ${job.retryBackoff}`
    )
    strictEqual(
      job.retryDelayMax,
      input.retryDelayMax,
      `retryDelayMax input ${input.retryDelayMax} didn't match job ${job.retryDelayMax}`
    )
    strictEqual(
      new Date(job.startAfter).toISOString(),
      input.startAfter,
      `startAfter input ${input.startAfter} didn't match job ${job.startAfter}`
    )
    strictEqual(
      job.expireInSeconds,
      input.expireInSeconds,
      `expireInSeconds input ${input.expireInSeconds} didn't match job ${job.expireInSeconds}`
    )
    strictEqual(
      job.deleteAfterSeconds,
      input.deleteAfterSeconds,
      `deleteAfterSeconds input ${input.deleteAfterSeconds} didn't match job ${job.deleteAfterSeconds}`
    )
    strictEqual(
      job.singletonKey,
      input.singletonKey,
      `name input ${input.singletonKey} didn't match job ${job.singletonKey}`
    )
    strictEqual(
      new Date(job.keepUntil).toISOString(),
      input.keepUntil,
      `keepUntil input ${input.keepUntil} didn't match job ${job.keepUntil}`
    )
  })

  it('should create jobs from an array with all properties and custom connection', async function () {
    const boss = (this.test.boss = await start(this.test.bossConfig))
    const queue = this.test.bossConfig.schema

    const deadLetter = `${queue}_dlq`
    await boss.createQueue(deadLetter)
    await boss.updateQueue(queue, { deadLetter })

    const input = {
      id: randomUUID(),
      name: queue,
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
      keepUntil: new Date().toISOString()
    }

    let called = false
    const db = await getDb()
    const options = {
      db: {
        async executeSql (sql, values) {
          called = true
          return db.pool.query(sql, values)
        }
      }
    }

    await boss.insert(queue, [input], options)

    const job = await boss.getJobById(queue, input.id)

    strictEqual(
      job.id,
      input.id,
      `id input ${input.id} didn't match job ${job.id}`
    )
    strictEqual(
      job.name,
      input.name,
      `name input ${input.name} didn't match job ${job.name}`
    )
    strictEqual(
      job.priority,
      input.priority,
      `priority input ${input.priority} didn't match job ${job.priority}`
    )
    strictEqual(
      JSON.stringify(job.data),
      JSON.stringify(input.data),
      `data input ${input.data} didn't match job ${job.data}`
    )
    strictEqual(
      job.retryLimit,
      input.retryLimit,
      `retryLimit input ${input.retryLimit} didn't match job ${job.retryLimit}`
    )
    strictEqual(
      job.retryDelay,
      input.retryDelay,
      `retryDelay input ${input.retryDelay} didn't match job ${job.retryDelay}`
    )
    strictEqual(
      job.retryBackoff,
      input.retryBackoff,
      `retryBackoff input ${input.retryBackoff} didn't match job ${job.retryBackoff}`
    )
    strictEqual(
      job.retryDelayMax,
      input.retryDelayMax,
      `retryDelayMax input ${input.retryDelayMax} didn't match job ${job.retryDelayMax}`
    )
    strictEqual(
      new Date(job.startAfter).toISOString(),
      input.startAfter,
      `startAfter input ${input.startAfter} didn't match job ${job.startAfter}`
    )
    strictEqual(
      job.expireInSeconds,
      input.expireInSeconds,
      `expireInSeconds input ${input.expireInSeconds} didn't match job ${job.expireInSeconds}`
    )
    strictEqual(
      job.deleteAfterSeconds,
      input.deleteAfterSeconds,
      `deleteAfterSeconds input ${input.deleteAfterSeconds} didn't match job ${job.deleteAfterSeconds}`
    )
    strictEqual(
      job.singletonKey,
      input.singletonKey,
      `name input ${input.singletonKey} didn't match job ${job.singletonKey}`
    )
    strictEqual(
      new Date(job.keepUntil).toISOString(),
      input.keepUntil,
      `keepUntil input ${input.keepUntil} didn't match job ${job.keepUntil}`
    )
    strictEqual(called, true)
  })
})
