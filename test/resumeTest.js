import assert, { strictEqual } from 'node:assert'
import { getDb, start } from './testHelper.js'

describe('cancel', () => {
  it('should reject missing id argument', async function () {
    const boss = (this.test.boss = await start(this.test.bossConfig))

    try {
      await boss.resume()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should cancel and resume a pending job', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { startAfter: 1 })

    await boss.cancel(queue, jobId)

    const job = await boss.getJobById(queue, jobId)

    assert(job && job.state === 'cancelled')

    await boss.resume(queue, jobId)

    const job2 = await boss.getJobById(queue, jobId)

    assert(job2 && job2.state === 'created')
  })

  it('should cancel and resume a pending job with custom connection', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { startAfter: 1 })

    let callCount = 0
    const _db = await getDb()
    const db = {
      async executeSql (sql, values) {
        callCount++
        return _db.pool.query(sql, values)
      }
    }

    await boss.cancel(queue, jobId, { db })

    const job = await boss.getJobById(queue, jobId, { db })

    assert(job && job.state === 'cancelled')

    await boss.resume(queue, jobId, { db })

    const job2 = await boss.getJobById(queue, jobId, { db })

    assert(job2 && job2.state === 'created')
    strictEqual(callCount, 4)
  })
})
