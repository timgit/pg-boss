const assert = require('assert')
const helper = require('./testHelper')

describe('cancel', function () {
  it('should reject missing id argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.resume()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should cancel and resume a pending job', async function () {
    const config = this.test.bossConfig
    const boss = this.test.boss = await helper.start(config)

    const jobId = await boss.send('will_cancel', null, { startAfter: 1 })

    await boss.cancel(jobId)

    const job = await boss.getJobById(jobId)

    assert(job && job.state === 'cancelled')

    await boss.resume(jobId)

    const job2 = await boss.getJobById(jobId)

    assert(job2 && job2.state === 'created')
  })

  it('should cancel and resume a pending job with custom connection', async function () {
    const config = this.test.bossConfig
    const boss = this.test.boss = await helper.start(config)

    const jobId = await boss.send('will_cancel', null, { startAfter: 1 })

    let callCount = 0
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        callCount++
        return _db.pool.query(sql, values)
      }
    }

    await boss.cancel(jobId, null, { db })

    const job = await boss.getJobById(jobId, { db })

    assert(job && job.state === 'cancelled')

    await boss.resume(jobId, { db })

    const job2 = await boss.getJobById(jobId, { db })

    assert(job2 && job2.state === 'created')
    assert.strictEqual(callCount, 4)
  })
})
