import assert from 'node:assert'
import * as helper from './testHelper.ts'

describe('cancel', function () {
  it('should reject missing id argument', async function () {
    this.boss = await helper.start(this.bossConfig)

    await assert.rejects(async () => {
      await this.boss.resume()
    })
  })

  it('should cancel and resume a pending job', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema, null, { startAfter: 1 })

    await this.boss.cancel(this.schema, jobId)

    const job = await this.boss.getJobById(this.schema, jobId)

    assert(job && job.state === 'cancelled')

    await this.boss.resume(this.schema, jobId)

    const job2 = await this.boss.getJobById(this.schema, jobId)

    assert(job2 && job2.state === 'created')
  })

  it('should cancel and resume a pending job with custom connection', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.send(this.schema, null, { startAfter: 1 })

    let callCount = 0
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        callCount++
        return _db.pool.query(sql, values)
      }
    }

    await this.boss.cancel(this.schema, jobId, { db })

    const job = await this.boss.getJobById(this.schema, jobId, { db })

    assert(job && job.state === 'cancelled')

    await this.boss.resume(this.schema, jobId, { db })

    const job2 = await this.boss.getJobById(this.schema, jobId, { db })

    assert(job2 && job2.state === 'created')
    assert.strictEqual(callCount, 4)
  })
})
