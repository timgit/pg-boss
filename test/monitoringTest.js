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

    assert.strictEqual(2, result1.queuedCount)
    assert.strictEqual(1, result1.activeCount)
    assert.strictEqual(3, result1.totalCount)

    const [job] = await boss.fetch(queue)
    await boss.complete(queue, job.id)

    await delay(1000)
    await boss.maintain(queue)
    const result2 = await boss.getQueue(queue)

    assert.strictEqual(1, result2.queuedCount)
    assert.strictEqual(1, result2.activeCount)
    assert.strictEqual(3, result2.totalCount)
  })

  it('queue cache should emit error', async function () {
    const config = {
      ...this.test.bossConfig,
      queueCacheIntervalSeconds: 1,
      __test__throw_queueCache: true
    }

    let errorCount = 0

    const boss = this.test.boss = await helper.start(config)

    boss.on('error', () => errorCount++)

    await delay(2000)

    assert(errorCount > 0)
  })

  it('slow maintenance should emit warning', async function () {
    const config = {
      ...this.test.bossConfig,
      __test__warn_slow_query: true,
      warningSlowQuerySeconds: 1
    }

    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    let eventCount = 0
    boss.on('warning', (event) => {
      assert(event.message.includes('slow'))
      eventCount++
    })

    await boss.maintain(queue)

    assert(eventCount > 0)
  })

  it('large queue should emit warning', async function () {
    const config = {
      ...this.test.bossConfig,
      monitorIntervalSeconds: 1,
      warningLargeQueueSize: 1,
      superviseIntervalSeconds: 1,
      supervise: true
    }

    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)

    let eventCount = 0

    boss.on('warning', (event) => {
      assert(event.message.includes('queue'))
      eventCount++
    })

    await boss.maintain(queue)

    await delay(4000)

    assert(eventCount > 0)
  })
})
