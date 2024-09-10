const assert = require('node:assert')
const helper = require('./testHelper')
const { delay } = require('../src/tools')

describe('monitoring', function () {
  it('should cache job counts into queue', async function () {
    const config = {
      ...this.test.bossConfig,
      monitorIntervalSeconds: 1
    }

    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)
    await boss.send(queue)
    await boss.fetch(queue)

    await delay(1000)
    await boss.maintain()
    const result1 = await boss.getQueue(queue)

    assert.strictEqual(2, result1.availableCount)
    assert.strictEqual(1, result1.activeCount)
    assert.strictEqual(3, result1.totalCount)

    const [job] = await boss.fetch(queue)
    await boss.complete(queue, job.id)

    await delay(1000)
    await boss.maintain()
    const result2 = await boss.getQueue(queue)

    assert.strictEqual(1, result2.availableCount)
    assert.strictEqual(1, result2.activeCount)
    assert.strictEqual(3, result2.totalCount)
  })
})
