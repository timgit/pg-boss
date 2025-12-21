import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('monitoring', function () {
  it('should cache job counts into queue', async function () {
    const config = {
      ...testContext.bossConfig,
      monitorIntervalSeconds: 1
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)
    await testContext.boss.fetch(testContext.schema)

    await delay(1000)
    await testContext.boss.supervise()
    const result1 = await testContext.boss.getQueue(testContext.schema)

    assert(result1)

    assert.strictEqual(2, result1.queuedCount)
    assert.strictEqual(1, result1.activeCount)
    assert.strictEqual(3, result1.totalCount)

    const [job] = await testContext.boss.fetch(testContext.schema)
    await testContext.boss.complete(testContext.schema, job.id)

    await delay(1000)
    await testContext.boss.supervise(testContext.schema)
    const result2 = await testContext.boss.getQueue(testContext.schema)

    assert(result2)

    assert.strictEqual(1, result2.queuedCount)
    assert.strictEqual(1, result2.activeCount)
    assert.strictEqual(3, result2.totalCount)
  })

  it('queue cache should emit error', async function () {
    const config = {
      ...testContext.bossConfig,
      queueCacheIntervalSeconds: 1,
      __test__throw_queueCache: true
    }

    let errorCount = 0

    testContext.boss = await helper.start(config)

    testContext.boss.on('error', () => errorCount++)

    await delay(2000)

    assert(errorCount > 0)
  })

  it('slow maintenance should emit warning', async function () {
    const config = {
      ...testContext.bossConfig,
      __test__warn_slow_query: true,
      warningSlowQuerySeconds: 1
    }

    testContext.boss = await helper.start(config)

    let eventCount = 0
    testContext.boss.on('warning', (event) => {
      assert(event.message.includes('slow'))
      eventCount++
    })

    await testContext.boss.supervise(testContext.schema)

    assert(eventCount > 0)
  })

  it('large queue should emit warning using global default', async function () {
    const config = {
      ...testContext.bossConfig,
      monitorIntervalSeconds: 1,
      warningQueueSize: 1
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)

    let eventCount = 0

    testContext.boss.on('warning', (event) => {
      assert(event.message.includes('queue'))
      eventCount++
    })

    await testContext.boss.supervise(testContext.schema)

    await delay(1000)

    assert(eventCount > 0)
  })

  it('large queue should emit warning via queue config', async function () {
    const config = {
      ...testContext.bossConfig,
      monitorIntervalSeconds: 1,
      noDefault: true
    }

    testContext.boss = await helper.start(config)
    await testContext.boss.createQueue(testContext.schema, { warningQueueSize: 1 })

    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)

    let eventCount = 0

    testContext.boss.on('warning', (event) => {
      assert(event.message.includes('queue'))
      eventCount++
    })

    await testContext.boss.supervise(testContext.schema)

    await delay(1000)

    assert(eventCount > 0)
  })

  it('should reset cached counts to zero when all jobs are deleted for given queue', async function () {
    const config = {
      ...testContext.bossConfig,
      monitorIntervalSeconds: 1
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)
    await testContext.boss.send(testContext.schema)

    await testContext.boss.supervise()

    await testContext.boss.deleteAllJobs(testContext.schema)

    await delay(1000)
    await testContext.boss.supervise()
    const result = await testContext.boss.getQueue(testContext.schema)
    assert(result)

    assert.strictEqual(0, result.queuedCount)
    assert.strictEqual(0, result.activeCount)
    assert.strictEqual(0, result.deferredCount)
    assert.strictEqual(0, result.totalCount)
  })
})
