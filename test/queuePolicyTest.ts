import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('queuePolicy', function () {
  [{ partition: false }, { partition: true }].forEach(({ partition }) => {
    it(`short policy only allows 1 job in testContext.schema using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'short', partition })

      const jobId = await testContext.boss.send(testContext.schema)

      expect(jobId).toBeTruthy()

      const jobId2 = await testContext.boss.send(testContext.schema)

      expect(jobId2).toBe(null)

      const [job] = await testContext.boss.fetch(testContext.schema)

      expect(job.id).toBe(jobId)

      const jobId3 = await testContext.boss.send(testContext.schema)

      expect(jobId3).toBeTruthy()
    })

    it(`short policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'short', partition })

      const jobId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      expect(jobId).toBeTruthy()

      const jobId2 = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      expect(jobId2).toBe(null)

      const jobId3 = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b' })

      expect(jobId3).toBeTruthy()

      const [job] = await testContext.boss.fetch(testContext.schema)

      expect(job.id).toBe(jobId)

      const jobId4 = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      expect(jobId4).toBeTruthy()
    })

    it(`singleton policy only allows 1 active job using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'singleton', partition })

      await testContext.boss.send(testContext.schema)

      await testContext.boss.send(testContext.schema)

      const [job1] = await testContext.boss.fetch(testContext.schema)

      const [job2] = await testContext.boss.fetch(testContext.schema)

      expect(job2).toBeFalsy()

      await testContext.boss.complete(testContext.schema, job1.id)

      const [job3] = await testContext.boss.fetch(testContext.schema)

      expect(job3).toBeTruthy()
    })

    it(`singleton policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'singleton', partition })

      await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      await testContext.boss.send(testContext.schema, null, { singletonKey: 'b' })

      const [job1] = await testContext.boss.fetch(testContext.schema)

      expect(job1).toBeTruthy()

      const [job2] = await testContext.boss.fetch(testContext.schema)

      expect(job2).toBeTruthy()

      await testContext.boss.send(testContext.schema, null, { singletonKey: 'b' })

      const [job3] = await testContext.boss.fetch(testContext.schema)

      expect(job3).toBeFalsy()

      await testContext.boss.complete(testContext.schema, job2.id)

      const [job3b] = await testContext.boss.fetch(testContext.schema)

      expect(job3b).toBeTruthy()
    })

    it(`stately policy only allows 1 job per state up to active using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'stately', partition })

      const jobId1 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      expect(jobId1).toBeTruthy()

      const blockedId = await testContext.boss.send(testContext.schema)

      expect(blockedId).toBe(null)

      const [job1] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, job1.id)

      const job1WithData = await testContext.boss.getJobById(testContext.schema, jobId1)

      expect(job1WithData!.state).toBe('retry')

      const jobId2 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      expect(jobId2).toBeTruthy()

      await testContext.boss.fetch(testContext.schema)

      const job1a = await testContext.boss.getJobById(testContext.schema, jobId1)

      expect(job1a!.state).toBe('active')

      const [blockedSecondActive] = await testContext.boss.fetch(testContext.schema)

      expect(blockedSecondActive).toBeFalsy()
    })

    it(`stately policy fails a job without retry when others are active using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })
      const deadLetter = testContext.schema + '_dlq'

      await testContext.boss.createQueue(deadLetter)
      await testContext.boss.createQueue(testContext.schema, { policy: 'stately', deadLetter, retryLimit: 3, partition })

      const jobId1 = await testContext.boss.send(testContext.schema, null, { expireInSeconds: 1 })
      expect(jobId1).toBeTruthy()
      await testContext.boss.fetch(testContext.schema)
      await testContext.boss.fail(testContext.schema, jobId1)
      const job1Data = await testContext.boss.getJobById(testContext.schema, jobId1)
      expect(job1Data!.state).toBe('retry')

      // higher priority new job should be active next
      const jobId2 = await testContext.boss.send(testContext.schema, null, { priority: 1, expireInSeconds: 1 })
      expect(jobId2).toBeTruthy()
      await testContext.boss.fetch(testContext.schema)

      const jobId3 = await testContext.boss.send(testContext.schema)
      expect(jobId3).toBeTruthy()

      await testContext.boss.fail(testContext.schema, jobId2)

      const job2Data = await testContext.boss.getJobById(testContext.schema, jobId2)

      expect(job2Data!.state).toBe('failed')

      const [job2Dlq] = await testContext.boss.fetch(deadLetter)

      expect(job2Dlq).toBeTruthy()
    })

    it(`stately policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'stately', partition })

      const jobAId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobAId).toBeTruthy()

      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })

      expect(jobBId).toBeTruthy()

      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobA2Id).toBe(null)

      const [jobA] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, jobA.id)

      let jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      expect(jobAWithData!.state).toBe('retry')

      await testContext.boss.fetch(testContext.schema)

      jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      expect(jobAWithData!.state).toBe('active')

      const [jobB] = await testContext.boss.fetch(testContext.schema)

      expect(jobB).toBeTruthy()

      const jobBWithData = await testContext.boss.getJobById(testContext.schema, jobBId)

      expect(jobBWithData!.state).toBe('active')

      const jobA3Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      expect(jobA3Id).toBeTruthy()

      const [jobA3] = await testContext.boss.fetch(testContext.schema)

      expect(jobA3).toBeFalsy()
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
      expect(jobA).toBeTruthy()

      // then, create another job in the testContext.schema for 'a'
      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      expect(jobA2Id).toBeTruthy()

      // now, testContext.schema a job for 'b', and attempt to fetch it
      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })
      expect(jobBId).toBeTruthy()

      const [jobB1] = await testContext.boss.fetch(testContext.schema)
      expect(jobB1).toBe(undefined)

      await testContext.boss.supervise()
      await delay(1500)

      const [jobB] = await testContext.boss.fetch(testContext.schema)
      expect(jobB).toBeTruthy()
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
      expect(jobA).toBeTruthy()

      // then, create another job in the testContext.schema for 'a'
      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })
      expect(jobA2Id).toBeTruthy()

      // now, testContext.schema a job for 'b', and attempt to fetch it
      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })
      expect(jobBId).toBeTruthy()

      const [jobB1] = await testContext.boss.fetch(testContext.schema)
      expect(jobB1).toBe(undefined)

      await testContext.boss.supervise()
      await delay(1500)

      const [jobB] = await testContext.boss.fetch(testContext.schema)
      expect(jobB).toBeTruthy()
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

      expect(jobs.length).toBe(3)
      expect(jobs.find(i => i.singletonKey === 'a')).toBeTruthy()
      expect(jobs.find(i => i.singletonKey === 'b')).toBeTruthy()

      await testContext.boss.complete(testContext.schema, jobs.map(i => i.id))

      const [job3] = await testContext.boss.fetch(testContext.schema, { includeMetadata: true })
      expect(job3.singletonKey).toBe('a')
    })

    it(`exclusive policy only allows 1 active,retry,created job using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'exclusive', partition })

      const jobId1 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      expect(jobId1).toBeTruthy()

      // it won't add a second job while the first is in created state
      const blockedId = await testContext.boss.send(testContext.schema)

      expect(blockedId).toBe(null)

      const [job1] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, job1.id)

      const job1WithData = await testContext.boss.getJobById(testContext.schema, jobId1)

      expect(job1WithData!.state).toBe('retry')

      // trying to send another job while one is in retry should not add the job
      const jobId2 = await testContext.boss.send(testContext.schema, null, { retryLimit: 1 })

      expect(jobId2).toBe(null)

      await testContext.boss.fetch(testContext.schema)

      const job1a = await testContext.boss.getJobById(testContext.schema, jobId1)

      expect(job1a!.state).toBe('active')

      const [blockedSecondActive] = await testContext.boss.fetch(testContext.schema)

      expect(blockedSecondActive).toBeFalsy()

      // We fail the job again, this time it goes to failed state
      await testContext.boss.fail(testContext.schema, jobId1)

      // sending a new job should work now that the first job is failed
      const newJobId = await testContext.boss.send(testContext.schema)
      expect(newJobId).toBeTruthy()
    })

    it(`exclusive policy should be extended with singletonKey using partition=${partition}`, async function () {
      testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

      await testContext.boss.createQueue(testContext.schema, { policy: 'exclusive', partition })

      const jobAId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobAId).toBeTruthy()

      const jobBId = await testContext.boss.send(testContext.schema, null, { singletonKey: 'b', retryLimit: 1 })

      expect(jobBId).toBeTruthy()

      const jobA2Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobA2Id).toBe(null)

      const [jobA] = await testContext.boss.fetch(testContext.schema)

      await testContext.boss.fail(testContext.schema, jobA.id)

      let jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      expect(jobAWithData!.state).toBe('retry')

      await testContext.boss.fetch(testContext.schema)

      jobAWithData = await testContext.boss.getJobById(testContext.schema, jobAId)

      expect(jobAWithData!.state).toBe('active')

      const [jobB] = await testContext.boss.fetch(testContext.schema)

      expect(jobB).toBeTruthy()

      const jobBWithData = await testContext.boss.getJobById(testContext.schema, jobBId)

      expect(jobBWithData!.state).toBe('active')

      // cannot send another 'a' job while one is active
      const jobA3Id = await testContext.boss.send(testContext.schema, null, { singletonKey: 'a' })

      expect(jobA3Id).toBeFalsy()

      const [jobA3] = await testContext.boss.fetch(testContext.schema)

      expect(jobA3).toBeFalsy()
    })
  })
})
