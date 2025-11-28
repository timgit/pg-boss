import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import type { ConstructorOptions } from '../src/types.ts'

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
    this.boss = await init(this.bossConfig)
    const queueData = await this.boss.getQueueStats(queue1)
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
    this.boss = await init(this.bossConfig)
    const queue3 = randomUUID()
    await this.boss.createQueue(queue3)

    const queueData = await this.boss.getQueueStats(queue3)
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
})
