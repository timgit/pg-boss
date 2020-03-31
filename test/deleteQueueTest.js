const assert = require('assert')
const helper = require('./testHelper')
const Promise = require('bluebird')

describe('deleteQueue', function () {
  it('should clear a specific queue', async function () {
    const queue1 = 'delete-named-queue-1'
    const queue2 = 'delete-named-queue-2'

    const config = this.test.bossConfig
    const boss = await helper.start(config)

    await boss.publish(queue1)
    await boss.publish(queue2)

    const q1Count1 = await boss.getQueueSize(queue1)
    const q2Count1 = await boss.getQueueSize(queue2)

    assert.strictEqual(1, q1Count1)
    assert.strictEqual(1, q2Count1)

    await boss.deleteQueue(queue1)

    const q1Count2 = await boss.getQueueSize(queue1)
    const q2Count2 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q1Count2)
    assert.strictEqual(1, q2Count2)

    await boss.deleteQueue(queue2)

    const q2Count3 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q2Count3)

    await boss.stop()
  })

  it('should clear all queues', async function () {
    const queue1 = 'delete-named-queue-11'
    const queue2 = 'delete-named-queue-22'

    const config = this.test.bossConfig
    const boss = await helper.start(config)

    await boss.publish(queue1)
    await boss.publish(queue2)

    const q1Count1 = await boss.getQueueSize(queue1)
    const q2Count1 = await boss.getQueueSize(queue2)

    assert.strictEqual(1, q1Count1)
    assert.strictEqual(1, q2Count1)

    await boss.deleteAllQueues()

    const q1Count2 = await boss.getQueueSize(queue1)
    const q2Count2 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q1Count2)
    assert.strictEqual(0, q2Count2)

    await boss.stop()
  })

  it('clearStorage() should empty both job storage tables', async function () {
    const defaults = {
      archiveIntervalSeconds: 1,
      maintenanceIntervalSeconds: 1
    }

    const config = { ...this.test.bossConfig, ...defaults }
    const boss = await helper.start(config)
    const queue = 'clear-storage-works'

    const jobId = await boss.publish(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(jobId)

    await Promise.delay(3000)

    const db = await helper.getDb()

    const getJobCount = async table => {
      const jobCountResult = await db.executeSql(`SELECT count(*)::int as job_count FROM ${config.schema}.${table}`)
      return jobCountResult.rows[0].job_count
    }

    const preJobCount = await getJobCount('job')
    const preArchiveCount = await getJobCount('archive')

    assert(preJobCount > 0)
    assert(preArchiveCount > 0)

    await boss.clearStorage()

    const postJobCount = await getJobCount('job')
    const postArchiveCount = await getJobCount('archive')

    assert(postJobCount === 0)
    assert(postArchiveCount === 0)

    await boss.stop()
  })
})
