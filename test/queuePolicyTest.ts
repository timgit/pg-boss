import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('queuePolicy', function () {
  [{ partition: false }, { partition: true }].forEach(({ partition }) => {
    it(`short policy only allows 1 job in testContext.schema using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'short', partition })

      const jobId = await testContext.boss.send(testContext.schema)

      assert(jobId)

      const jobId2 = await testContext.boss.send(testContext.schema)

      assert.strictEqual(jobId2, null)

      const [job] = await testContext.boss.fetch(testContext.schema)

      assert.strictEqual(job.id, jobId)

      const jobId3 = await testContext.boss.send(testContext.schema)

      assert(jobId3)
    })

    it(`short policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'short', partition })

      const jobId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      assert(jobId)

      const jobId2 = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      assert.strictEqual(jobId2, null)

      const jobId3 = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b' })

      assert(jobId3)

      const [job] = await testContext.boss.fetch(testContext.schema)

      assert.strictEqual(job.id, jobId)

      const jobId4 = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      assert(jobId4)
    })

    it(`singleton policy only allows 1 active job using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'singleton', partition })

      await testContext.boss.send(testContext.schema)

      await testContext.boss.send(testContext.schema)

      const [job1] = await testContext.boss.fetch(testContext.schema)

      const [job2] = await testContext.boss.fetch(testContext.schema)

      assert(!job2)

      await testContext.boss.complete(testContext.schema, job1.id)

      const [job3] = await testContext.boss.fetch(testContext.schema)

      assert(job3)
    })

    it(`singleton policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'singleton', partition })

      await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      await testContext.boss.send(testContext.schema, null, { singletonKey: 'b' })

      const [job1] = await testContext.boss.fetch(testContext.schema)

      assert(job1)

      const [job2] = await testContext.boss.fetch(testContext.schema)

      assert(job2)

      await testContext.boss.send(testContext.schema, null, { singletonKey: 'b' })

      const [job3] = await testContext.boss.fetch(testContext.schema)

      assert(!job3)

      await testContext.boss.complete(testContext.schema, job2.id)

      const [job3b] = await testContext.boss.fetch(testContext.schema)

      assert(job3b)
    })

    it(`stately policy only allows 1 job per state up to active using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'stately', partition })

      const jobId1 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      assert(jobId1)

      const blockedId = await testContext.boss.send(testContext.schema)

      assert.strictEqual(blockedId, null)

      const [job1] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, job1.id)

      const job1WithData = await testContext.boss.getJobById(testContext.schema, jobId1)

      assert.strictEqual(job1WithData!.state, 'retry')

      const jobId2 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      assert(jobId2)

      await testContext.boss.fetch(testContext.schema)

      const job1a = await testContext.boss.getJobById(testContext.schema, jobId1)

      assert.strictEqual(job1a!.state, 'active')

      const [blockedSecondActive] = await testContext.boss.fetch(testContext.schema)

      assert(!blockedSecondActive)
    })

    it(`stately policy fails a job without retry when others are active using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
      const deadLetter = testContext.schema + '_dlq'

      await testContext.boss.createQueue(deadLetter)
      await testContext.boss.createQueue(testContext.schema, { policy: 'stately', deadLetter, retryLimit: 3, partition })

      const jobId1 = await testContext.boss.send(testContext.schema, null, { expireInSeconds: 1 })
      assert(jobId1)
      await testContext.boss.fetch(testContext.schema)
      await testContext.boss.fail(testContext.schema, jobId1)
      const job1Data = await testContext.boss.getJobById(testContext.schema, jobId1)
      assert.strictEqual(job1Data!.state, 'retry')

      // higher priority new job should be active next
      const jobId2 = await testContext.boss.send(testContext.schema, null, { priority: 1, expireInSeconds: 1 })
      assert(jobId2)
      await testContext.boss.fetch(testContext.schema)

      const jobId3 = await testContext.boss.send(testContext.schema)
      assert(jobId3)

      await testContext.boss.fail(testContext.schema, jobId2)

      const job2Data = await testContext.boss.getJobById(testContext.schema, jobId2)

      assert.strictEqual(job2Data!.state, 'failed')

      const [job2Dlq] = await testContext.boss.fetch(deadLetter)

      assert(job2Dlq)
    })

    it(`stately policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'stately', partition })

      const jobAId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert(jobAId)

      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })

      assert(jobBId)

      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert.strictEqual(jobA2Id, null)

      const [jobA] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, jobA.id)

      let jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'retry')

      await testContext.boss.fetch(testContext.schema)

      jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'active')

      const [jobB] = await testContext.boss.fetch(testContext.schema)

      assert(jobB)

      const jobBWithData = await testContext.boss.getJobById(testContext.schema, jobBId)

      assert.strictEqual(jobBWithData!.state, 'active')

      const jobA3Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      assert(jobA3Id)

      const [jobA3] = await testContext.boss.fetch(testContext.schema)

      assert(!jobA3)
    })

    it(`stately policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...testContext.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      testContext.boss = await helper.start(config)

      await testContext.boss.createQueue(testContext.schema, { policy: 'stately', partition })

      // put singleton key 'a' into active state
      await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await testContext.boss.fetch(testContext.schema)
      assert(jobA)

      // then, create another job in the testContext.schema for 'a'
      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      assert(jobA2Id)

      // now, testContext.schema a job for 'b', and attempt to fetch it
      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })
      assert(jobBId)

      const [jobB1] = await testContext.boss.fetch(testContext.schema)
      assert.strictEqual(jobB1, undefined)

      await testContext.boss.supervise()
      await delay(1500)

      const [jobB] = await testContext.boss.fetch(testContext.schema)
      assert(jobB)
    })

    it(`singleton policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...testContext.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      testContext.boss = await helper.start(config)

      await testContext.boss.createQueue(testContext.schema, { policy: 'singleton', partition })

      // put singleton key 'a' into active state
      await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await testContext.boss.fetch(testContext.schema)
      assert(jobA)

      // then, create another job in the testContext.schema for 'a'
      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      assert(jobA2Id)

      // now, testContext.schema a job for 'b', and attempt to fetch it
      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })
      assert(jobBId)

      const [jobB1] = await testContext.boss.fetch(testContext.schema)
      assert.strictEqual(jobB1, undefined)

      await testContext.boss.supervise()
      await delay(1500)

      const [jobB] = await testContext.boss.fetch(testContext.schema)
      assert(jobB)
    })

    it(`singleton policy with multiple singletonKeys in the testContext.schema should only promote 1 of each keep up to the requested batch size using partition=${partition}`, async function () {
      const config = {
        ...testContext.bossConfig,
        noDefault: true
      }

      testContext.boss = await helper.start(config)

      await testContext.boss.createQueue(testContext.schema, { policy: 'singleton', partition })

      await testContext.boss.send(testContext.schema, null)
      await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })

      const jobs = await testContext.boss.fetch(testContext.schema, { batchSize: 4, includeMetadata: true })

      assert.strictEqual(jobs.length, 3)
      assert(jobs.find(i => i.singletonKey === 'a'))
      assert(jobs.find(i => i.singletonKey === 'b'))

      await testContext.boss.complete(testContext.schema, jobs.map(i => i.id))

      const [job3] = await testContext.boss.fetch(testContext.schema, { includeMetadata: true })
      assert.strictEqual(job3.singletonKey, 'a')
    })

    it(`exclusive policy only allows 1 active,retry,created job using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'exclusive', partition })

      const jobId1 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      assert(jobId1)

      // it won't add a second job while the first is in created state
      const blockedId = await testContext.boss.send(testContext.schema)

      assert.strictEqual(blockedId, null)

      const [job1] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, job1.id)

      const job1WithData = await testContext.boss.getJobById(testContext.schema, jobId1)

      assert.strictEqual(job1WithData!.state, 'retry')

      // trying to send another job while one is in retry should not add the job
      const jobId2 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      assert.strictEqual(jobId2, null)

      await testContext.boss.fetch(testContext.schema)

      const job1a = await testContext.boss.getJobById(testContext.schema, jobId1)

      assert.strictEqual(job1a!.state, 'active')

      const [blockedSecondActive] = await testContext.boss.fetch(testContext.schema)

      assert(!blockedSecondActive)

      // We fail the job again, this time it goes to failed state
      await testContext.boss.fail(testContext.schema, jobId1)

      // sending a new job should work now that the first job is failed
      const newJobId = await testContext.boss.send(testContext.schema)
      assert(newJobId)
    })

    it(`exclusive policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'exclusive', partition })

      const jobAId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert(jobAId)

      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })

      assert(jobBId)

      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      assert.strictEqual(jobA2Id, null)

      const [jobA] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, jobA.id)

      let jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'retry')

      await testContext.boss.fetch(testContext.schema)

      jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      assert.strictEqual(jobAWithData!.state, 'active')

      const [jobB] = await testContext.boss.fetch(testContext.schema)

      assert(jobB)

      const jobBWithData = await testContext.boss.getJobById(testContext.schema, jobBId)

      assert.strictEqual(jobBWithData!.state, 'active')

      // cannot send another 'a' job while one is active
      const jobA3Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      assert(!jobA3Id)

      const [jobA3] = await testContext.boss.fetch(testContext.schema)

      assert(!jobA3)
    })
  })
})
