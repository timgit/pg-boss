const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('deleteQueue', function () {
  it('should clear a specific queue', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue2 = 'delete-named-queue-2'
    const queue1 = 'delete-named-queue-1'

    await boss.send(queue1)
    await boss.send(queue2)

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
  })

  it('should clear a specific queue and state', async function () {
    const defaults = {
      archiveCompletedAfterSeconds: 1,
      maintenanceIntervalSeconds: 1
    }
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'delete-queue-by-state-works'

    const jobId = await boss.send(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(jobId)

    await delay(3000)

    const db = await helper.getDb()

    const getJobCount = async table => {
      const jobCountResult = await db.executeSql(`SELECT count(*)::int as job_count FROM ${this.test.bossConfig.schema}.${table}`)
      return jobCountResult.rows[0].job_count
    }

    const preJobCount = await getJobCount('job')
    const preArchiveCount = await getJobCount('archive')

    assert(preJobCount === 1)
    assert(preArchiveCount === 1)

    await boss.deleteQueue(queue, { before: 'completed' })

    const postJobCount = await getJobCount('job')
    const postArchiveCount = await getJobCount('archive')

    assert(postJobCount === 0)
    assert(postArchiveCount > 0) // archive should still have records
  })

  it('should clear all queues', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue1 = 'delete-named-queue-11'
    const queue2 = 'delete-named-queue-22'

    await boss.send(queue1)
    await boss.send(queue2)

    const q1Count1 = await boss.getQueueSize(queue1)
    const q2Count1 = await boss.getQueueSize(queue2)

    assert.strictEqual(1, q1Count1)
    assert.strictEqual(1, q2Count1)

    await boss.deleteAllQueues()

    const q1Count2 = await boss.getQueueSize(queue1)
    const q2Count2 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q1Count2)
    assert.strictEqual(0, q2Count2)
  })

  it('clearStorage() should empty both job storage tables', async function () {
    const defaults = {
      archiveCompletedAfterSeconds: 1,
      maintenanceIntervalSeconds: 1
    }
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const queue = 'clear-storage-works'

    const jobId = await boss.send(queue)
    const job = await boss.fetch(queue)

    assert.strictEqual(job.id, jobId)

    await boss.complete(jobId)

    await delay(3000)

    const db = await helper.getDb()

    const getJobCount = async table => {
      const jobCountResult = await db.executeSql(`SELECT count(*)::int as job_count FROM ${this.test.bossConfig.schema}.${table}`)
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
  })
})
