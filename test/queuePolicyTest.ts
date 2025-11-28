import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('queuePolicy', function () {
  [{ partition: false }, { partition: true }].forEach(({ partition }) => {
    it(`short policy only allows 1 job in this.schema using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'short', partition })

      const jobId = await this.boss.send(this.schema)

      assert(jobId)

      const jobId2 = await this.boss.send(this.schema)

      assert.strictEqual(jobId2, null)

      const [job] = await this.boss.fetch(this.schema)

      assert.strictEqual(job.id, jobId)

      const jobId3 = await this.boss.send(this.schema)

      assert(jobId3)
    })

    it(`short policy should be extended with singletonKey using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'short', partition })

      const jobId = await this.boss.send(this.schema, null, { singletonKey: 'a' })

      assert(jobId)

      const jobId2 = await this.boss.send(this.schema, null, { singletonKey: 'a' })

      assert.strictEqual(jobId2, null)

      const jobId3 = await this.boss.send(this.schema, null, { singletonKey: 'b' })

      assert(jobId3)

      const [job] = await this.boss.fetch(this.schema)

      assert.strictEqual(job.id, jobId)

      const jobId4 = await this.boss.send(this.schema, null, { singletonKey: 'a' })

      assert(jobId4)
    })

    it(`singleton policy only allows 1 active job using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'singleton', partition })

      await this.boss.send(this.schema)

      await this.boss.send(this.schema)

      const [job1] = await this.boss.fetch(this.schema)

      const [job2] = await this.boss.fetch(this.schema)

      assert(!job2)

      await this.boss.complete(this.schema, job1.id)

      const [job3] = await this.boss.fetch(this.schema)

      assert(job3)
    })

    it(`singleton policy should be extended with singletonKey using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'singleton', partition })

      await this.boss.send(this.schema, null, { singletonKey: 'a' })

      await this.boss.send(this.schema, null, { singletonKey: 'b' })

      const [job1] = await this.boss.fetch(this.schema)

      assert(job1)

      const [job2] = await this.boss.fetch(this.schema)

      assert(job2)

      await this.boss.send(this.schema, null, { singletonKey: 'b' })

      const [job3] = await this.boss.fetch(this.schema)

      assert(!job3)

      await this.boss.complete(this.schema, job2.id)

      const [job3b] = await this.boss.fetch(this.schema)

      assert(job3b)
    })

    it(`stately policy only allows 1 job per state up to active using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'stately', partition })

      const jobId1 = await this.boss.send(this.schema, null, { retryLimit: 1 })

      assert(jobId1)

      const blockedId = await this.boss.send(this.schema)

      assert.strictEqual(blockedId, null)

      const [job1] = await this.boss.fetch(this.schema)

      await this.boss.fail(this.schema, job1.id)

      const job1WithData = await this.boss.getJobById(this.schema, jobId1)

      assert.strictEqual(job1WithData!.state, 'retry')

      const jobId2 = await this.boss.send(this.schema, null, { retryLimit: 1 })

      assert(jobId2)

      await this.boss.fetch(this.schema)

      const job1a = await this.boss.getJobById(this.schema, jobId1)

      assert.strictEqual(job1a!.state, 'active')

      const [blockedSecondActive] = await this.boss.fetch(this.schema)

      assert(!blockedSecondActive)
    })

    it(`stately policy fails a job without retry when others are active using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })
      const deadLetter = this.schema + '_dlq'

      await this.boss.createQueue(deadLetter)
      await this.boss.createQueue(this.schema, { policy: 'stately', deadLetter, retryLimit: 3, partition })

      const jobId1 = await this.boss.send(this.schema, null, { expireInSeconds: 1 })
      assert(jobId1)
      await this.boss.fetch(this.schema)
      await this.boss.fail(this.schema, jobId1)
      const job1Data = await this.boss.getJobById(this.schema, jobId1)
      assert.strictEqual(job1Data!.state, 'retry')

      // higher priority new job should be active next
      const jobId2 = await this.boss.send(this.schema, null, { priority: 1, expireInSeconds: 1 })
      assert(jobId2)
      await this.boss.fetch(this.schema)

      const jobId3 = await this.boss.send(this.schema)
      assert(jobId3)

      await this.boss.fail(this.schema, jobId2)

      const job2Data = await this.boss.getJobById(this.schema, jobId2)

      assert.strictEqual(job2Data!.state, 'failed')

      const [job2Dlq] = await this.boss.fetch(deadLetter)

      assert(job2Dlq)
    })

    it(`stately policy should be extended with singletonKey using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'stately', partition })

      const jobAId = await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert(jobAId)

      const jobBId = await this.boss.send(this.schema, null, { singletonKey: 'b', retryLimit: 1 })

      assert(jobBId)

      const jobA2Id = await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert.strictEqual(jobA2Id, null)

      const [jobA] = await this.boss.fetch(this.schema)

      await this.boss.fail(this.schema, jobA.id)

      let jobAWithData = await this.boss.getJobById(this.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'retry')

      await this.boss.fetch(this.schema)

      jobAWithData = await this.boss.getJobById(this.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'active')

      const [jobB] = await this.boss.fetch(this.schema)

      assert(jobB)

      const jobBWithData = await this.boss.getJobById(this.schema, jobBId)

      assert.strictEqual(jobBWithData!.state, 'active')

      const jobA3Id = await this.boss.send(this.schema, null, { singletonKey: 'a' })

      assert(jobA3Id)

      const [jobA3] = await this.boss.fetch(this.schema)

      assert(!jobA3)
    })

    it(`stately policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...this.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      this.boss = await helper.start(config)

      await this.boss.createQueue(this.schema, { policy: 'stately', partition })

      // put singleton key 'a' into active state
      await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await this.boss.fetch(this.schema)
      assert(jobA)

      // then, create another job in the this.schema for 'a'
      const jobA2Id = await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })
      assert(jobA2Id)

      // now, this.schema a job for 'b', and attempt to fetch it
      const jobBId = await this.boss.send(this.schema, null, { singletonKey: 'b', retryLimit: 1 })
      assert(jobBId)

      const [jobB1] = await this.boss.fetch(this.schema)
      assert.strictEqual(jobB1, undefined)

      await this.boss.supervise()
      await delay(1500)

      const [jobB] = await this.boss.fetch(this.schema)
      assert(jobB)
    })

    it(`singleton policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...this.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      this.boss = await helper.start(config)

      await this.boss.createQueue(this.schema, { policy: 'singleton', partition })

      // put singleton key 'a' into active state
      await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await this.boss.fetch(this.schema)
      assert(jobA)

      // then, create another job in the this.schema for 'a'
      const jobA2Id = await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })
      assert(jobA2Id)

      // now, this.schema a job for 'b', and attempt to fetch it
      const jobBId = await this.boss.send(this.schema, null, { singletonKey: 'b', retryLimit: 1 })
      assert(jobBId)

      const [jobB1] = await this.boss.fetch(this.schema)
      assert.strictEqual(jobB1, undefined)

      await this.boss.supervise()
      await delay(1500)

      const [jobB] = await this.boss.fetch(this.schema)
      assert(jobB)
    })

    it(`singleton policy with multiple singletonKeys in the this.schema should only promote 1 of each keep up to the requested batch size using partition=${partition}`, async function () {
      const config = {
        ...this.bossConfig,
        noDefault: true
      }

      this.boss = await helper.start(config)

      await this.boss.createQueue(this.schema, { policy: 'singleton', partition })

      await this.boss.send(this.schema, null)
      await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })
      await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })
      await this.boss.send(this.schema, null, { singletonKey: 'b', retryLimit: 1 })

      const jobs = await this.boss.fetch(this.schema, { batchSize: 4, includeMetadata: true })

      assert.strictEqual(jobs.length, 3)
      assert(jobs.find(i => i.singletonKey === 'a'))
      assert(jobs.find(i => i.singletonKey === 'b'))

      await this.boss.complete(this.schema, jobs.map(i => i.id))

      const [job3] = await this.boss.fetch(this.schema, { includeMetadata: true })
      assert.strictEqual(job3.singletonKey, 'a')
    })

    it(`exclusive policy only allows 1 active,retry,created job using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'exclusive', partition })

      const jobId1 = await this.boss.send(this.schema, null, { retryLimit: 1 })

      assert(jobId1)

      // it won't add a second job while the first is in created state
      const blockedId = await this.boss.send(this.schema)

      assert.strictEqual(blockedId, null)

      const [job1] = await this.boss.fetch(this.schema)

      await this.boss.fail(this.schema, job1.id)

      const job1WithData = await this.boss.getJobById(this.schema, jobId1)

      assert.strictEqual(job1WithData!.state, 'retry')

      // trying to send another job while one is in retry should not add the job
      const jobId2 = await this.boss.send(this.schema, null, { retryLimit: 1 })

      assert.strictEqual(jobId2, null)

      await this.boss.fetch(this.schema)

      const job1a = await this.boss.getJobById(this.schema, jobId1)

      assert.strictEqual(job1a!.state, 'active')

      const [blockedSecondActive] = await this.boss.fetch(this.schema)

      assert(!blockedSecondActive)

      // We fail the job again, this time it goes to failed state
      await this.boss.fail(this.schema, jobId1)

      // sending a new job should work now that the first job is failed
      const newJobId = await this.boss.send(this.schema)
      assert(newJobId)
    })

    it(`exclusive policy should be extended with singletonKey using partition=${partition}`, async function () {
      this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

      await this.boss.createQueue(this.schema, { policy: 'exclusive', partition })

      const jobAId = await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert(jobAId)

      const jobBId = await this.boss.send(this.schema, null, { singletonKey: 'b', retryLimit: 1 })

      assert(jobBId)

      const jobA2Id = await this.boss.send(this.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert.strictEqual(jobA2Id, null)

      const [jobA] = await this.boss.fetch(this.schema)

      await this.boss.fail(this.schema, jobA.id)

      let jobAWithData = await this.boss.getJobById(this.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'retry')

      await this.boss.fetch(this.schema)

      jobAWithData = await this.boss.getJobById(this.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'active')

      const [jobB] = await this.boss.fetch(this.schema)

      assert(jobB)

      const jobBWithData = await this.boss.getJobById(this.schema, jobBId)

      assert.strictEqual(jobBWithData!.state, 'active')

      // cannot send another 'a' job while one is active
      const jobA3Id = await this.boss.send(this.schema, null, { singletonKey: 'a' })

      assert(!jobA3Id)

      const [jobA3] = await this.boss.fetch(this.schema)

      assert(!jobA3)
    })
  })
})
