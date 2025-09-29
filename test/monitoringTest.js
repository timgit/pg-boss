import assert, { strictEqual } from 'node:assert'
import { delay } from '../src/tools.ts'
import { start } from './testHelper.js'

describe('monitoring', () => {
  it('should cache job counts into queue', async function () {
    const config = {
      ...this.test.bossConfig,
      monitorIntervalSeconds: 1
    }

    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)
    await boss.send(queue)
    await boss.fetch(queue)

    await delay(1000)
    await boss.supervise()
    const result1 = await boss.getQueue(queue)

    strictEqual(2, result1.queuedCount)
    strictEqual(1, result1.activeCount)
    strictEqual(3, result1.totalCount)

    const [job] = await boss.fetch(queue)
    await boss.complete(queue, job.id)

    await delay(1000)
    await boss.supervise(queue)
    const result2 = await boss.getQueue(queue)

    strictEqual(1, result2.queuedCount)
    strictEqual(1, result2.activeCount)
    strictEqual(3, result2.totalCount)
  })

  it('queue cache should emit error', async function () {
    const config = {
      ...this.test.bossConfig,
      queueCacheIntervalSeconds: 1,
      __test__throw_queueCache: true
    }

    let errorCount = 0

    const boss = (this.test.boss = await start(config))

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

    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    let eventCount = 0
    boss.on('warning', (event) => {
      assert(event.message.includes('slow'))
      eventCount++
    })

    await boss.supervise(queue)

    assert(eventCount > 0)
  })

  it('large queue should emit warning using global default', async function () {
    const config = {
      ...this.test.bossConfig,
      monitorIntervalSeconds: 1,
      warningQueueSize: 1
    }

    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)

    let eventCount = 0

    boss.on('warning', (event) => {
      assert(event.message.includes('queue'))
      eventCount++
    })

    await boss.supervise(queue)

    await delay(1000)

    assert(eventCount > 0)
  })

  it('large queue should emit warning via queue config', async function () {
    const config = {
      ...this.test.bossConfig,
      monitorIntervalSeconds: 1,
      noDefault: true
    }

    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema
    await boss.createQueue(queue, { warningQueueSize: 1 })

    await boss.send(queue)
    await boss.send(queue)

    let eventCount = 0

    boss.on('warning', (event) => {
      assert(event.message.includes('queue'))
      eventCount++
    })

    await boss.supervise(queue)

    await delay(1000)

    assert(eventCount > 0)
  })
})
