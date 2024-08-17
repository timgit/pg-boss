const assert = require('assert')
const { randomUUID } = require('crypto')
const helper = require('./testHelper')

describe('insert', function () {
  it('should create jobs from an array with name only', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const input = [{ name: queue }, { name: queue }, { name: queue }]

    await boss.insert(input)

    const count = await boss.getQueueSize(queue)

    assert.strictEqual(count, 3)
  })

  it('should create jobs from an array with all properties', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const deadLetter = `${queue}_dlq`
    await boss.createQueue(deadLetter)

    const input = {
      id: randomUUID(),
      name: queue,
      priority: 1,
      data: { some: 'data' },
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      singletonKey: '123',
      keepUntil: new Date().toISOString(),
      deadLetter
    }

    await boss.insert([input])

    const job = await boss.getJobById(queue, input.id)

    assert.strictEqual(job.id, input.id, `id input ${input.id} didn't match job ${job.id}`)
    assert.strictEqual(job.name, input.name, `name input ${input.name} didn't match job ${job.name}`)
    assert.strictEqual(job.priority, input.priority, `priority input ${input.priority} didn't match job ${job.priority}`)
    assert.strictEqual(JSON.stringify(job.data), JSON.stringify(input.data), `data input ${input.data} didn't match job ${job.data}`)
    assert.strictEqual(job.retryLimit, input.retryLimit, `retryLimit input ${input.retryLimit} didn't match job ${job.retryLimit}`)
    assert.strictEqual(job.retryDelay, input.retryDelay, `retryDelay input ${input.retryDelay} didn't match job ${job.retryDelay}`)
    assert.strictEqual(job.retryBackoff, input.retryBackoff, `retryBackoff input ${input.retryBackoff} didn't match job ${job.retryBackoff}`)
    assert.strictEqual(new Date(job.startAfter).toISOString(), input.startAfter, `startAfter input ${input.startAfter} didn't match job ${job.startAfter}`)
    assert.strictEqual(job.expireIn.seconds, input.expireInSeconds, `expireInSeconds input ${input.expireInSeconds} didn't match job ${job.expireIn}`)
    assert.strictEqual(job.singletonKey, input.singletonKey, `name input ${input.singletonKey} didn't match job ${job.singletonKey}`)
    assert.strictEqual(new Date(job.keepUntil).toISOString(), input.keepUntil, `keepUntil input ${input.keepUntil} didn't match job ${job.keepUntil}`)
    assert.strictEqual(job.deadLetter, input.deadLetter, `deadLetter input ${input.deadLetter} didn't match job ${job.deadLetter}`)
  })

  it('should create jobs from an array with all properties and custom connection', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const deadLetter = `${queue}_dlq`
    await boss.createQueue(deadLetter)

    const input = {
      id: randomUUID(),
      name: queue,
      priority: 1,
      data: { some: 'data' },
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      singletonKey: '123',
      keepUntil: new Date().toISOString(),
      deadLetter
    }
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

    await boss.insert([input], options)

    const job = await boss.getJobById(queue, input.id)

    assert.strictEqual(job.id, input.id, `id input ${input.id} didn't match job ${job.id}`)
    assert.strictEqual(job.name, input.name, `name input ${input.name} didn't match job ${job.name}`)
    assert.strictEqual(job.priority, input.priority, `priority input ${input.priority} didn't match job ${job.priority}`)
    assert.strictEqual(JSON.stringify(job.data), JSON.stringify(input.data), `data input ${input.data} didn't match job ${job.data}`)
    assert.strictEqual(job.retryLimit, input.retryLimit, `retryLimit input ${input.retryLimit} didn't match job ${job.retryLimit}`)
    assert.strictEqual(job.retryDelay, input.retryDelay, `retryDelay input ${input.retryDelay} didn't match job ${job.retryDelay}`)
    assert.strictEqual(job.retryBackoff, input.retryBackoff, `retryBackoff input ${input.retryBackoff} didn't match job ${job.retryBackoff}`)
    assert.strictEqual(new Date(job.startAfter).toISOString(), input.startAfter, `startAfter input ${input.startAfter} didn't match job ${job.startAfter}`)
    assert.strictEqual(job.expireIn.seconds, input.expireInSeconds, `expireInSeconds input ${input.expireInSeconds} didn't match job ${job.expireIn}`)
    assert.strictEqual(job.singletonKey, input.singletonKey, `name input ${input.singletonKey} didn't match job ${job.singletonKey}`)
    assert.strictEqual(new Date(job.keepUntil).toISOString(), input.keepUntil, `keepUntil input ${input.keepUntil} didn't match job ${job.keepUntil}`)
    assert.strictEqual(job.deadLetter, input.deadLetter, `deadLetter input ${input.deadLetter} didn't match job ${job.deadLetter}`)
    assert.strictEqual(called, true)
  })
})
