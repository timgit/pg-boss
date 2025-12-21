import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import type { ConstructorOptions } from '../src/types.ts'
import { testContext } from './hooks.ts'

describe('queueStats', function () {
  const queue1 = `q${randomUUID().replaceAll('-', '')}`
  const queue2 = `q${randomUUID().replaceAll('-', '')}`

  async function init (config: (ConstructorOptions & { schema: string }) | (Partial<ConstructorOptions> & { testKey?: string; noDefault?: boolean }) | undefined) {
    const boss = await helper.start(config)

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    await boss.send(queue1)
    await boss.send(queue1)
    await boss.send(queue2)
    await boss.send(queue2)

    return boss
  }

  it('should get accurate stats', async function () {
    testContext.boss = await init(testContext.bossConfig)
    const queueData = await testContext.boss.getQueueStats(queue1)
    assert.notEqual(queueData, undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      activeCount,
      totalCount
    } = queueData!

    assert.equal(name, queue1)
    assert.equal(deferredCount, 0)
    assert.equal(queuedCount, 2)
    assert.equal(activeCount, 0)
    assert.equal(totalCount, 2)
  })

  it('should get accurate stats on an empty queue', async function () {
    testContext.boss = await init(testContext.bossConfig)
    const queue3 = randomUUID()
    await testContext.boss.createQueue(queue3)

    const queueData = await testContext.boss.getQueueStats(queue3)
    assert.notEqual(queueData, undefined)

    const {
      name,
      deferredCount,
      queuedCount,
      activeCount,
      totalCount
    } = queueData

    assert.equal(name, queue3)
    assert.equal(deferredCount, 0)
    assert.equal(queuedCount, 0)
    assert.equal(activeCount, 0)
    assert.equal(totalCount, 0)
  })

  it('should properly get queue stats when all jobs are deleted', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, monitorIntervalSeconds: 1, queueCacheIntervalSeconds: 1 })

    const queue4 = randomUUID()
    await testContext.boss.createQueue(queue4)

    await testContext.boss.send(queue4)
    await testContext.boss.send(queue4)
    await testContext.boss.send(queue4)

    await testContext.boss.supervise(queue4)

    await testContext.boss.deleteAllJobs(queue4)

    await testContext.boss.supervise(queue4)

    // wait for a second for queueCache to update
    await new Promise(resolve => setTimeout(resolve, 1000))

    const queueData = await testContext.boss.getQueueStats(queue4)
    assert(queueData)

    assert.equal(queueData.deferredCount, 0)
    assert.equal(queueData.queuedCount, 0)
    assert.equal(queueData.activeCount, 0)
    assert.equal(queueData.totalCount, 0)
  })
})
