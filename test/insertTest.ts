import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import * as helper from './testHelper.ts'

describe('insert', function () {
  it('should create jobs from an array with name only', async function () {
    this.boss = await helper.start(this.bossConfig)

    const input = [{ name: this.schema }, { name: this.schema }, { name: this.schema }]

    await this.boss.insert(this.schema, input)

    const { queuedCount } = await this.boss.getQueueStats(this.schema)

    assert.strictEqual(queuedCount, 3)
  })

  it('should create jobs from an array with all properties', async function () {
    this.boss = await helper.start(this.bossConfig)

    const deadLetter = `${this.schema}_dlq`
    await this.boss.createQueue(deadLetter)
    await this.boss.updateQueue(this.schema, { deadLetter })

    const input = {
      id: randomUUID(),
      name: this.schema,
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

    await this.boss.insert(this.schema, [input])

    const job = await this.boss.getJobById(this.schema, input.id)

    assert.strictEqual(job.id, input.id, `id input ${input.id} didn't match job ${job.id}`)
    assert.strictEqual(job.name, input.name, `name input ${input.name} didn't match job ${job.name}`)
    assert.strictEqual(job.priority, input.priority, `priority input ${input.priority} didn't match job ${job.priority}`)
    assert.strictEqual(JSON.stringify(job.data), JSON.stringify(input.data), `data input ${input.data} didn't match job ${job.data}`)
    assert.strictEqual(job.retryLimit, input.retryLimit, `retryLimit input ${input.retryLimit} didn't match job ${job.retryLimit}`)
    assert.strictEqual(job.retryDelay, input.retryDelay, `retryDelay input ${input.retryDelay} didn't match job ${job.retryDelay}`)
    assert.strictEqual(job.retryBackoff, input.retryBackoff, `retryBackoff input ${input.retryBackoff} didn't match job ${job.retryBackoff}`)
    assert.strictEqual(job.retryDelayMax, input.retryDelayMax, `retryDelayMax input ${input.retryDelayMax} didn't match job ${job.retryDelayMax}`)
    assert.strictEqual(new Date(job.startAfter).toISOString(), input.startAfter, `startAfter input ${input.startAfter} didn't match job ${job.startAfter}`)
    assert.strictEqual(job.expireInSeconds, input.expireInSeconds, `expireInSeconds input ${input.expireInSeconds} didn't match job ${job.expireInSeconds}`)
    assert.strictEqual(job.deleteAfterSeconds, input.deleteAfterSeconds, `deleteAfterSeconds input ${input.deleteAfterSeconds} didn't match job ${job.deleteAfterSeconds}`)
    assert.strictEqual(job.singletonKey, input.singletonKey, `name input ${input.singletonKey} didn't match job ${job.singletonKey}`)
    assert.strictEqual(new Date(job.keepUntil).toISOString(), keepUntil, `keepUntil input ${keepUntil} didn't match job ${job.keepUntil}`)
  })

  it('should create jobs from an array with all properties and custom connection', async function () {
    this.boss = await helper.start(this.bossConfig)

    const deadLetter = `${this.schema}_dlq`
    await this.boss.createQueue(deadLetter)
    await this.boss.updateQueue(this.schema, { deadLetter })

    const input = {
      id: randomUUID(),
      name: this.schema,
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
        async executeSql (sql, values) {
          called = true
          return db.pool.query(sql, values)
        }
      }
    }

    await this.boss.insert(this.schema, [input], options)

    const job = await this.boss.getJobById(this.schema, input.id)

    assert.strictEqual(job.id, input.id, `id input ${input.id} didn't match job ${job.id}`)
    assert.strictEqual(job.name, input.name, `name input ${input.name} didn't match job ${job.name}`)
    assert.strictEqual(job.priority, input.priority, `priority input ${input.priority} didn't match job ${job.priority}`)
    assert.strictEqual(JSON.stringify(job.data), JSON.stringify(input.data), `data input ${input.data} didn't match job ${job.data}`)
    assert.strictEqual(job.retryLimit, input.retryLimit, `retryLimit input ${input.retryLimit} didn't match job ${job.retryLimit}`)
    assert.strictEqual(job.retryDelay, input.retryDelay, `retryDelay input ${input.retryDelay} didn't match job ${job.retryDelay}`)
    assert.strictEqual(job.retryBackoff, input.retryBackoff, `retryBackoff input ${input.retryBackoff} didn't match job ${job.retryBackoff}`)
    assert.strictEqual(job.retryDelayMax, input.retryDelayMax, `retryDelayMax input ${input.retryDelayMax} didn't match job ${job.retryDelayMax}`)
    assert.strictEqual(new Date(job.startAfter).toISOString(), input.startAfter, `startAfter input ${input.startAfter} didn't match job ${job.startAfter}`)
    assert.strictEqual(job.expireInSeconds, input.expireInSeconds, `expireInSeconds input ${input.expireInSeconds} didn't match job ${job.expireInSeconds}`)
    assert.strictEqual(job.deleteAfterSeconds, input.deleteAfterSeconds, `deleteAfterSeconds input ${input.deleteAfterSeconds} didn't match job ${job.deleteAfterSeconds}`)
    assert.strictEqual(job.singletonKey, input.singletonKey, `name input ${input.singletonKey} didn't match job ${job.singletonKey}`)
    assert.strictEqual(new Date(job.keepUntil).toISOString(), keepUntil, `keepUntil input ${keepUntil} didn't match job ${job.keepUntil}`)
    assert.strictEqual(called, true)
  })
})
