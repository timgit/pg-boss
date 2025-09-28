import assert, { strictEqual } from 'node:assert'
import { getDb, start } from './testHelper.js'

describe('cancel', () => {
  it('should reject missing arguments', async function () {
    const boss = (this.test.boss = await start(this.test.bossConfig))

    try {
      await boss.cancel()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should cancel a pending job', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { startAfter: 1 })

    await boss.cancel(queue, jobId)

    const job = await boss.getJobById(queue, jobId)

    assert(job && job.state === 'cancelled')
  })

  it('should not cancel a completed job', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const [job] = await boss.fetch(queue)

    const completeResult = await boss.complete(queue, job.id)

    strictEqual(completeResult.affected, 1)

    const cancelResult = await boss.cancel(queue, job.id)

    strictEqual(cancelResult.affected, 0)
  })

  it('should cancel a batch of jobs', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const jobs = await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    await boss.cancel(queue, jobs)
  })

  it('should cancel a pending job with custom connection', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    let called = false
    const _db = await getDb()
    const db = {
      async executeSql (sql, values) {
        called = true
        return _db.pool.query(sql, values)
      }
    }

    const jobId = await boss.send(queue, null, { startAfter: 1 })

    await boss.cancel(queue, jobId, { db })

    const job = await boss.getJobById(queue, jobId)

    assert(job && job.state === 'cancelled')
    strictEqual(called, true)
  })
})
