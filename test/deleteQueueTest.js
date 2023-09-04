const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('purgeQueue', function () {
  it('should clear a specific queue', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue1 = `${this.test.bossConfig.schema}1`
    const queue2 = `${this.test.bossConfig.schema}2`

    await boss.send(queue1)
    await boss.send(queue2)

    const q1Count1 = await boss.getQueueSize(queue1)
    const q2Count1 = await boss.getQueueSize(queue2)

    assert.strictEqual(1, q1Count1)
    assert.strictEqual(1, q2Count1)

    await boss.purgeQueue(queue1)

    const q1Count2 = await boss.getQueueSize(queue1)
    const q2Count2 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q1Count2)
    assert.strictEqual(1, q2Count2)

    await boss.purgeQueue(queue2)

    const q2Count3 = await boss.getQueueSize(queue2)

    assert.strictEqual(0, q2Count3)
  })

  it('clearStorage() should empty both job storage tables', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, archiveCompletedAfterSeconds: 1 })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)
    await boss.fetch(queue)
    await boss.complete(jobId)

    await delay(1000)
    await boss.maintain()

    await boss.send(queue)

    const db = await helper.getDb()

    const getJobCount = async table => {
      const jobCountResult = await db.executeSql(`SELECT count(*)::int as job_count FROM ${this.test.bossConfig.schema}.${table}`)
      return jobCountResult.rows[0].job_count
    }

    const preJobCount = await getJobCount('job')
    const preArchiveCount = await getJobCount('archive')

    assert.strictEqual(preJobCount, 1)
    assert.strictEqual(preArchiveCount, 1)

    await boss.clearStorage()

    const postJobCount = await getJobCount('job')
    const postArchiveCount = await getJobCount('archive')

    assert.strictEqual(postJobCount, 0)
    assert.strictEqual(postArchiveCount, 0)
  })
})
