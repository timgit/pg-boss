const assert = require('assert')
const { v4: uuid } = require('uuid')
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

    const input = {
      id: uuid(),
      name: queue,
      priority: 1,
      data: { some: 'data' },
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      startAfter: new Date().toISOString(),
      expireIn: 5,
      singletonKey: '123',
      keepUntil: new Date().toISOString(),
      onComplete: true
    }

    await boss.insert([input])

    const job = await boss.getJobById(input.id)

    assert.strictEqual(job.id, input.id, `id input ${input.id} didn't match job ${job.id}`)
    assert.strictEqual(job.name, input.name, `name input ${input.name} didn't match job ${job.name}`)
    assert.strictEqual(job.priority, input.priority, `priority input ${input.priority} didn't match job ${job.priority}`)
    assert.strictEqual(JSON.stringify(job.data), JSON.stringify(input.data), `data input ${input.data} didn't match job ${job.data}`)
    assert.strictEqual(job.retrylimit, input.retryLimit, `retryLimit input ${input.retryLimit} didn't match job ${job.retrylimit}`)
    assert.strictEqual(job.retrydelay, input.retryDelay, `retryDelay input ${input.retryDelay} didn't match job ${job.retrydelay}`)
    assert.strictEqual(job.retrybackoff, input.retryBackoff, `retryBackoff input ${input.retryBackoff} didn't match job ${job.retrybackoff}`)
    assert.strictEqual(new Date(job.startafter).toISOString(), input.startAfter, `startAfter input ${input.startAfter} didn't match job ${job.startafter}`)
    assert.strictEqual(job.expirein.seconds, input.expireIn, `expireIn input ${input.expireIn} didn't match job ${job.expirein}`)
    assert.strictEqual(job.singletonkey, input.singletonKey, `name input ${input.singletonKey} didn't match job ${job.singletonkey}`)
    assert.strictEqual(new Date(job.keepuntil).toISOString(), input.keepUntil, `keepUntil input ${input.keepUntil} didn't match job ${job.keepuntil}`)
    assert.strictEqual(job.on_complete, input.onComplete, `onComplete input ${input.onComplete} didn't match job ${job.on_complete}`)
  })
})
