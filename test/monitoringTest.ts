import { expect } from 'vitest'
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

    expect(result1).toBeTruthy()

    expect(result1!.queuedCount).toBe(2)
    expect(result1!.activeCount).toBe(1)
    expect(result1!.totalCount).toBe(3)

    const [job] = await testContext.boss.fetch(testContext.schema)
    await testContext.boss.complete(testContext.schema, job.id)

    await delay(1000)
    await testContext.boss.supervise(testContext.schema)
    const result2 = await testContext.boss.getQueue(testContext.schema)

    expect(result2).toBeTruthy()

    expect(result2!.queuedCount).toBe(1)
    expect(result2!.activeCount).toBe(1)
    expect(result2!.totalCount).toBe(3)
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

    expect(errorCount > 0).toBeTruthy()
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
      expect(event.message.includes('slow')).toBeTruthy()
      eventCount++
    })

    await testContext.boss.supervise(testContext.schema)

    expect(eventCount > 0).toBeTruthy()
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
      expect(event.message.includes('queue')).toBeTruthy()
      eventCount++
    })

    await testContext.boss.supervise(testContext.schema)

    await delay(1000)

    expect(eventCount > 0).toBeTruthy()
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
      expect(event.message.includes('queue')).toBeTruthy()
      eventCount++
    })

    await testContext.boss.supervise(testContext.schema)

    await delay(1000)

    expect(eventCount > 0).toBeTruthy()
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
    expect(result).toBeTruthy()

    expect(result!.queuedCount).toBe(0)
    expect(result!.activeCount).toBe(0)
    expect(result!.deferredCount).toBe(0)
    expect(result!.totalCount).toBe(0)
  })
})
