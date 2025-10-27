import assert from 'node:assert'
import * as helper from './testHelper.js'
import { delay } from '../src/tools.ts'

describe('queuePolicy', function () {
  [{ partition: false }, { partition: true }].forEach(({ partition }) => {
    it(`short policy only allows 1 job in queue using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'short', partition })

      const jobId = await boss.send(queue)

      assert(jobId)

      const jobId2 = await boss.send(queue)

      assert.strictEqual(jobId2, null)

      const [job] = await boss.fetch(queue)

      assert.strictEqual(job.id, jobId)

      const jobId3 = await boss.send(queue)

      assert(jobId3)
    })

    it(`short policy should be extended with singletonKey using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'short', partition })

      const jobId = await boss.send(queue, null, { singletonKey: 'a' })

      assert(jobId)

      const jobId2 = await boss.send(queue, null, { singletonKey: 'a' })

      assert.strictEqual(jobId2, null)

      const jobId3 = await boss.send(queue, null, { singletonKey: 'b' })

      assert(jobId3)

      const [job] = await boss.fetch(queue)

      assert.strictEqual(job.id, jobId)

      const jobId4 = await boss.send(queue, null, { singletonKey: 'a' })

      assert(jobId4)
    })

    it(`singleton policy only allows 1 active job using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'singleton', partition })

      await boss.send(queue)

      await boss.send(queue)

      const [job1] = await boss.fetch(queue)

      const [job2] = await boss.fetch(queue)

      assert(!job2)

      await boss.complete(queue, job1.id)

      const [job3] = await boss.fetch(queue)

      assert(job3)
    })

    it(`singleton policy should be extended with singletonKey using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'singleton', partition })

      await boss.send(queue, null, { singletonKey: 'a' })

      await boss.send(queue, null, { singletonKey: 'b' })

      const [job1] = await boss.fetch(queue)

      assert(job1)

      const [job2] = await boss.fetch(queue)

      assert(job2)

      await boss.send(queue, null, { singletonKey: 'b' })

      const [job3] = await boss.fetch(queue)

      assert(!job3)

      await boss.complete(queue, job2.id)

      const [job3b] = await boss.fetch(queue)

      assert(job3b)
    })

    it(`stately policy only allows 1 job per state up to active using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'stately', partition })

      const jobId1 = await boss.send(queue, null, { retryLimit: 1 })

      const blockedId = await boss.send(queue)

      assert.strictEqual(blockedId, null)

      let [job1] = await boss.fetch(queue)

      await boss.fail(queue, job1.id)

      job1 = await boss.getJobById(queue, jobId1)

      assert.strictEqual(job1.state, 'retry')

      const jobId2 = await boss.send(queue, null, { retryLimit: 1 })

      assert(jobId2)

      await boss.fetch(queue)

      const job1a = await boss.getJobById(queue, jobId1)

      assert.strictEqual(job1a.state, 'active')

      const [blockedSecondActive] = await boss.fetch(queue)

      assert(!blockedSecondActive)
    })

    it(`stately policy fails a job without retry when others are active using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema
      const deadLetter = queue + '_dlq'

      await boss.createQueue(deadLetter)
      await boss.createQueue(queue, { policy: 'stately', deadLetter, retryLimit: 3, partition })

      const jobId1 = await boss.send(queue, null, { expireInSeconds: 1 })
      await boss.fetch(queue)
      await boss.fail(queue, jobId1)
      const job1Data = await boss.getJobById(queue, jobId1)
      assert.strictEqual(job1Data.state, 'retry')

      // higher priority new job should be active next
      const jobId2 = await boss.send(queue, null, { priority: 1, expireInSeconds: 1 })
      await boss.fetch(queue)

      const jobId3 = await boss.send(queue)
      assert(jobId3)

      await boss.fail(queue, jobId2)

      const job2Data = await boss.getJobById(queue, jobId2)

      assert.strictEqual(job2Data.state, 'failed')

      const [job2Dlq] = await boss.fetch(deadLetter)

      assert(job2Dlq)
    })

    it(`stately policy should be extended with singletonKey using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'stately', partition })

      const jobAId = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

      assert(jobAId)

      const jobBId = await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })

      assert(jobBId)

      const jobA2Id = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

      assert.strictEqual(jobA2Id, null)

      let [jobA] = await boss.fetch(queue)

      await boss.fail(queue, jobA.id)

      jobA = await boss.getJobById(queue, jobAId)

      assert.strictEqual(jobA.state, 'retry')

      await boss.fetch(queue)

      jobA = await boss.getJobById(queue, jobAId)

      assert.strictEqual(jobA.state, 'active')

      let [jobB] = await boss.fetch(queue)

      assert(jobB)

      jobB = await boss.getJobById(queue, jobBId)

      assert.strictEqual(jobB.state, 'active')

      const jobA3Id = await boss.send(queue, null, { singletonKey: 'a' })

      assert(jobA3Id)

      const [jobA3] = await boss.fetch(queue)

      assert(!jobA3)
    })

    it(`stately policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...this.test.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      const boss = this.test.boss = await helper.start(config)
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'stately', partition })

      // put singleton key 'a' into active state
      await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await boss.fetch(queue)
      assert(jobA)

      // then, create another job in the queue for 'a'
      const jobA2Id = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
      assert(jobA2Id)

      // now, queue a job for 'b', and attempt to fetch it
      const jobBId = await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })
      assert(jobBId)

      const [jobB1] = await boss.fetch(queue)
      assert.strictEqual(jobB1, undefined)

      await boss.supervise()
      await delay(1500)

      const [jobB] = await boss.fetch(queue)
      assert(jobB)
    })

    it(`singleton policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...this.test.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      const boss = this.test.boss = await helper.start(config)
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'singleton', partition })

      // put singleton key 'a' into active state
      await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await boss.fetch(queue)
      assert(jobA)

      // then, create another job in the queue for 'a'
      const jobA2Id = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
      assert(jobA2Id)

      // now, queue a job for 'b', and attempt to fetch it
      const jobBId = await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })
      assert(jobBId)

      const [jobB1] = await boss.fetch(queue)
      assert.strictEqual(jobB1, undefined)

      await boss.supervise()
      await delay(1500)

      const [jobB] = await boss.fetch(queue)
      assert(jobB)
    })

    it(`singleton policy with multiple singletonKeys in the queue should only promote 1 of each keep up to the requested batch size using partition=${partition}`, async function () {
      const config = {
        ...this.test.bossConfig,
        noDefault: true
      }

      const boss = this.test.boss = await helper.start(config)
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'singleton', partition })

      await boss.send(queue, null)
      await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
      await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
      await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })

      const jobs = await boss.fetch(queue, { batchSize: 4, includeMetadata: true })

      assert.strictEqual(jobs.length, 3)
      assert(jobs.find(i => i.singletonKey === 'a'))
      assert(jobs.find(i => i.singletonKey === 'b'))

      await boss.complete(queue, jobs.map(i => i.id))

      const [job3] = await boss.fetch(queue, { includeMetadata: true })
      assert.strictEqual(job3.singletonKey, 'a')
    })

    it(`exclusive policy only allows 1 active,retry,created job using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'exclusive', partition })

      const jobId1 = await boss.send(queue, null, { retryLimit: 1 })

      // it won't add a second job while the first is in created state
      const blockedId = await boss.send(queue)

      assert.strictEqual(blockedId, null)

      let [job1] = await boss.fetch(queue)

      await boss.fail(queue, job1.id)

      job1 = await boss.getJobById(queue, jobId1)

      assert.strictEqual(job1.state, 'retry')

      // trying to send another job while one is in retry should not add the job
      const jobId2 = await boss.send(queue, null, { retryLimit: 1 })

      assert.strictEqual(jobId2, null)

      await boss.fetch(queue)

      const job1a = await boss.getJobById(queue, jobId1)

      assert.strictEqual(job1a.state, 'active')

      const [blockedSecondActive] = await boss.fetch(queue)

      assert(!blockedSecondActive)

      // We fail the job again, this time it goes to failed state
      await boss.fail(queue, jobId1)

      // sending a new job should work now that the first job is failed
      const newJobId = await boss.send(queue)
      assert(newJobId)
    })

    it(`exclusive policy should be extended with singletonKey using partition=${partition}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
      const queue = this.test.bossConfig.schema

      await boss.createQueue(queue, { policy: 'exclusive', partition })

      const jobAId = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

      assert(jobAId)

      const jobBId = await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })

      assert(jobBId)

      const jobA2Id = await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })

      assert.strictEqual(jobA2Id, null)

      let [jobA] = await boss.fetch(queue)

      await boss.fail(queue, jobA.id)

      jobA = await boss.getJobById(queue, jobAId)

      assert.strictEqual(jobA.state, 'retry')

      await boss.fetch(queue)

      jobA = await boss.getJobById(queue, jobAId)

      assert.strictEqual(jobA.state, 'active')

      let [jobB] = await boss.fetch(queue)

      assert(jobB)

      jobB = await boss.getJobById(queue, jobBId)

      assert.strictEqual(jobB.state, 'active')

      // cannot send another 'a' job while one is active
      const jobA3Id = await boss.send(queue, null, { singletonKey: 'a' })

      assert(!jobA3Id)

      const [jobA3] = await boss.fetch(queue)

      assert(!jobA3)
    })
  })
})
