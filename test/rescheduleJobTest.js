const assert = require('assert')
const uuid = require('uuid')
const helper = require('./testHelper')

describe('reschedule', function () {
  it('should reject missing name argument with "rescheduleJobBySingletonKey" function', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.rescheduleJobBySingletonKey()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should reject missing singletonKey argument with "rescheduleJobBySingletonKey" function', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.rescheduleJobBySingletonKey('pgboss_queue')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should reject missing startAfter argument with "rescheduleJobBySingletonKey" function', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.rescheduleJobBySingletonKey('pgboss_queue', 'singleton_key')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should reject missing id argument with "rescheduleJobById" function', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.rescheduleJobById()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should reject missing startAfter argument with "rescheduleJobById" function', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.rescheduleJobById(uuid.v4())
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should reschedule a pending job', async function () {
    const config = this.test.bossConfig
    const queueName = 'will_reschedule'
    const singletonKey = 'singletonKey'
    const boss = this.test.boss = await helper.start(config)
    const incrementByFiveMin = 60 * 1000

    const originalTime = new Date().getTime() + incrementByFiveMin
    const jobId = await boss.send(queueName, null, { startAfter: new Date(originalTime), singletonKey })

    const newTime = new Date(originalTime + incrementByFiveMin)
    await boss.rescheduleJobById(jobId, newTime)
    const job = await boss.getJobById(jobId)
    assert(job && new Date(job.startafter).getTime() === newTime.getTime())

    const newTime2 = new Date(newTime.getTime() + incrementByFiveMin)
    await boss.rescheduleJobBySingletonKey(queueName, singletonKey, newTime2)
    const job2 = await boss.getJobById(jobId)
    assert(job2 && new Date(job2.startafter).getTime() === newTime2.getTime())
  })

  it('should reschedule a pending job with custom connection and retention option input', async function () {
    const config = this.test.bossConfig
    const queueName = 'will_reschedule'
    const singletonKey = 'singletonKey'
    const boss = this.test.boss = await helper.start(config)
    const incrementByFiveMin = 60 * 1000

    const originalTime = new Date().getTime() + incrementByFiveMin
    const jobId = await boss.send('will_reschedule', null, { startAfter: new Date(originalTime), singletonKey })
    const newTime = new Date(originalTime + incrementByFiveMin)

    let callCount = 0
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        callCount++
        return _db.pool.query(sql, values)
      }
    }

    await boss.rescheduleJobById(jobId, newTime, { db, retentionDays: 20 })
    const job = await boss.getJobById(jobId, { db })
    const retentionDate = new Date()
    retentionDate.setDate(newTime.getDate() + 20)
    assert(job && new Date(job.startafter).getTime() === newTime.getTime())
    assert(new Date(job.keepuntil).getDate() === retentionDate.getDate())

    const newTime2 = new Date(newTime.getTime() + incrementByFiveMin)
    await boss.rescheduleJobBySingletonKey(queueName, singletonKey, newTime2, { db, retentionDays: 20 })
    const job2 = await boss.getJobById(jobId, { db })
    const retentionDate2 = new Date()
    retentionDate2.setDate(newTime2.getDate() + 20)
    assert(job2 && new Date(job2.startafter).getTime() === newTime2.getTime())
    assert(new Date(job2.keepuntil).getDate() === retentionDate2.getDate())

    assert.strictEqual(callCount, 4)
  })
})
