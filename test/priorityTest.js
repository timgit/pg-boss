const assert = require('assert')
const helper = require('./testHelper')

describe('priority', function () {
  it('higher priority job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const high = await boss.send(queue, null, { priority: 1 })

    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, high)
  })

  it('descending priority order', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const low = await boss.send(queue, null, { priority: 1 })
    const medium = await boss.send(queue, null, { priority: 5 })
    const high = await boss.send(queue, null, { priority: 10 })

    const job1 = await boss.fetch(queue)
    const job2 = await boss.fetch(queue)
    const job3 = await boss.fetch(queue)

    assert.strictEqual(job1.id, high)
    assert.strictEqual(job2.id, medium)
    assert.strictEqual(job3.id, low)
  })
})
