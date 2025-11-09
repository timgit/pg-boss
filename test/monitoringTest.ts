import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('monitoring', function () {
  it('should cache job counts into queue', async function () {
    const config = {
      ...this.bossConfig,
      monitorIntervalSeconds: 1
    }

    this.boss = await helper.start(config)

    await this.boss.send(this.schema)
    await this.boss.send(this.schema)
    await this.boss.send(this.schema)
    await this.boss.fetch(this.schema)

    await delay(1000)
    await this.boss.supervise()
    const result1 = await this.boss.getQueue(this.schema)

    assert.strictEqual(2, result1.queuedCount)
    assert.strictEqual(1, result1.activeCount)
    assert.strictEqual(3, result1.totalCount)

    const [job] = await this.boss.fetch(this.schema)
    await this.boss.complete(this.schema, job.id)

    await delay(1000)
    await this.boss.supervise(this.schema)
    const result2 = await this.boss.getQueue(this.schema)

    assert.strictEqual(1, result2.queuedCount)
    assert.strictEqual(1, result2.activeCount)
    assert.strictEqual(3, result2.totalCount)
  })

  it('queue cache should emit error', async function () {
    const config = {
      ...this.bossConfig,
      queueCacheIntervalSeconds: 1,
      __test__throw_queueCache: true
    }

    let errorCount = 0

    this.boss = await helper.start(config)

    this.boss.on('error', () => errorCount++)

    await delay(2000)

    assert(errorCount > 0)
  })

  it('slow maintenance should emit warning', async function () {
    const config = {
      ...this.bossConfig,
      __test__warn_slow_query: true,
      warningSlowQuerySeconds: 1
    }

    this.boss = await helper.start(config)

    let eventCount = 0
    this.boss.on('warning', (event) => {
      assert(event.message.includes('slow'))
      eventCount++
    })

    await this.boss.supervise(this.schema)

    assert(eventCount > 0)
  })

  it('large queue should emit warning using global default', async function () {
    const config = {
      ...this.bossConfig,
      monitorIntervalSeconds: 1,
      warningQueueSize: 1
    }

    this.boss = await helper.start(config)

    await this.boss.send(this.schema)
    await this.boss.send(this.schema)

    let eventCount = 0

    this.boss.on('warning', (event) => {
      assert(event.message.includes('queue'))
      eventCount++
    })

    await this.boss.supervise(this.schema)

    await delay(1000)

    assert(eventCount > 0)
  })

  it('large queue should emit warning via queue config', async function () {
    const config = {
      ...this.bossConfig,
      monitorIntervalSeconds: 1,
      noDefault: true
    }

    this.boss = await helper.start(config)
    await this.boss.createQueue(this.schema, { warningQueueSize: 1 })

    await this.boss.send(this.schema)
    await this.boss.send(this.schema)

    let eventCount = 0

    this.boss.on('warning', (event) => {
      assert(event.message.includes('queue'))
      eventCount++
    })

    await this.boss.supervise(this.schema)

    await delay(1000)

    assert(eventCount > 0)
  })
})
