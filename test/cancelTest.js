const assert = require('assert')
const helper = require('./testHelper')

describe('cancel', function () {
  it('should reject missing id argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.cancel()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should cancel a pending job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { startAfter: 1 })

    await boss.cancel(jobId)

    const job = await boss.getJobById(jobId)

    assert(job && job.state === 'cancelled')
  })

  it('should not cancel a completed job', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const job = await boss.fetch(queue)

    const completeResult = await boss.complete(job.id)

    assert.strictEqual(completeResult.updated, 1)

    const cancelResult = await boss.cancel(job.id)

    assert.strictEqual(cancelResult.updated, 0)
  })

  it('should cancel a batch of jobs', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobs = await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    await boss.cancel(jobs)
  })

  it('should cancel a pending job with custom connection', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        called = true
        return _db.pool.query(sql, values)
      }
    }

    const jobId = await boss.send(queue, null, { startAfter: 1 })

    await boss.cancel(jobId, { db })

    const job = await boss.getJobById(jobId)

    assert(job && job.state === 'cancelled')
    assert.strictEqual(called, true)
  })
})
