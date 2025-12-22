import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('queuePolicy', function () {
  [{ partition: false }, { partition: true }].forEach(({ partition }) => {
    it(`short policy only allows 1 job in ctx.schema using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'short', partition })

      const jobId = await ctx.boss.send(ctx.schema)

      expect(jobId).toBeTruthy()

      const jobId2 = await ctx.boss.send(ctx.schema)

      expect(jobId2).toBe(null)

      const [job] = await ctx.boss.fetch(ctx.schema)

      expect(job.id).toBe(jobId)

      const jobId3 = await ctx.boss.send(ctx.schema)

      expect(jobId3).toBeTruthy()
    })

    it(`short policy should be extended with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'short', partition })

      const jobId = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a' })

      expect(jobId).toBeTruthy()

      const jobId2 = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a' })

      expect(jobId2).toBe(null)

      const jobId3 = await ctx.boss.send(ctx.schema, null, { singletonKey: 'b' })

      expect(jobId3).toBeTruthy()

      const [job] = await ctx.boss.fetch(ctx.schema)

      expect(job.id).toBe(jobId)

      const jobId4 = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a' })

      expect(jobId4).toBeTruthy()
    })

    it(`singleton policy only allows 1 active job using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton', partition })

      await ctx.boss.send(ctx.schema)

      await ctx.boss.send(ctx.schema)

      const [job1] = await ctx.boss.fetch(ctx.schema)

      const [job2] = await ctx.boss.fetch(ctx.schema)

      expect(job2).toBeFalsy()

      await ctx.boss.complete(ctx.schema, job1.id)

      const [job3] = await ctx.boss.fetch(ctx.schema)

      expect(job3).toBeTruthy()
    })

    it(`singleton policy should be extended with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton', partition })

      await ctx.boss.send(ctx.schema, null, { singletonKey: 'a' })

      await ctx.boss.send(ctx.schema, null, { singletonKey: 'b' })

      const [job1] = await ctx.boss.fetch(ctx.schema)

      expect(job1).toBeTruthy()

      const [job2] = await ctx.boss.fetch(ctx.schema)

      expect(job2).toBeTruthy()

      await ctx.boss.send(ctx.schema, null, { singletonKey: 'b' })

      const [job3] = await ctx.boss.fetch(ctx.schema)

      expect(job3).toBeFalsy()

      await ctx.boss.complete(ctx.schema, job2.id)

      const [job3b] = await ctx.boss.fetch(ctx.schema)

      expect(job3b).toBeTruthy()
    })

    it(`stately policy only allows 1 job per state up to active using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'stately', partition })

      const jobId1 = await ctx.boss.send(ctx.schema, null, { retryLimit: 1 })

      expect(jobId1).toBeTruthy()

      const blockedId = await ctx.boss.send(ctx.schema)

      expect(blockedId).toBe(null)

      const [job1] = await ctx.boss.fetch(ctx.schema)

      await ctx.boss.fail(ctx.schema, job1.id)

      assertTruthy(jobId1)
      const job1WithData = await ctx.boss.getJobById(ctx.schema, jobId1)

      assertTruthy(job1WithData)
      expect(job1WithData.state).toBe('retry')

      const jobId2 = await ctx.boss.send(ctx.schema, null, { retryLimit: 1 })

      expect(jobId2).toBeTruthy()

      await ctx.boss.fetch(ctx.schema)

      const job1a = await ctx.boss.getJobById(ctx.schema, jobId1)

      assertTruthy(job1a)
      expect(job1a.state).toBe('active')

      const [blockedSecondActive] = await ctx.boss.fetch(ctx.schema)

      expect(blockedSecondActive).toBeFalsy()
    })

    it(`stately policy fails a job without retry when others are active using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      const deadLetter = ctx.schema + '_dlq'

      await ctx.boss.createQueue(deadLetter)
      await ctx.boss.createQueue(ctx.schema, { policy: 'stately', deadLetter, retryLimit: 3, partition })

      const jobId1 = await ctx.boss.send(ctx.schema, null, { expireInSeconds: 1 })
      expect(jobId1).toBeTruthy()
      await ctx.boss.fetch(ctx.schema)
      assertTruthy(jobId1)
      await ctx.boss.fail(ctx.schema, jobId1)
      const job1Data = await ctx.boss.getJobById(ctx.schema, jobId1)
      assertTruthy(job1Data)
      expect(job1Data.state).toBe('retry')

      // higher priority new job should be active next
      const jobId2 = await ctx.boss.send(ctx.schema, null, { priority: 1, expireInSeconds: 1 })
      expect(jobId2).toBeTruthy()
      await ctx.boss.fetch(ctx.schema)

      const jobId3 = await ctx.boss.send(ctx.schema)
      expect(jobId3).toBeTruthy()

      assertTruthy(jobId2)
      await ctx.boss.fail(ctx.schema, jobId2)

      const job2Data = await ctx.boss.getJobById(ctx.schema, jobId2)

      assertTruthy(job2Data)
      expect(job2Data.state).toBe('failed')

      const [job2Dlq] = await ctx.boss.fetch(deadLetter)

      expect(job2Dlq).toBeTruthy()
    })

    it(`stately policy should be extended with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'stately', partition })

      const jobAId = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobAId).toBeTruthy()

      const jobBId = await ctx.boss.send(ctx.schema, null, { singletonKey: 'b', retryLimit: 1 })

      expect(jobBId).toBeTruthy()

      const jobA2Id = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobA2Id).toBe(null)

      const [jobA] = await ctx.boss.fetch(ctx.schema)

      await ctx.boss.fail(ctx.schema, jobA.id)

      assertTruthy(jobAId)
      let jobAWithData = await ctx.boss.getJobById(ctx.schema, jobAId)

      assertTruthy(jobAWithData)
      expect(jobAWithData.state).toBe('retry')

      await ctx.boss.fetch(ctx.schema)

      jobAWithData = await ctx.boss.getJobById(ctx.schema, jobAId)

      assertTruthy(jobAWithData)
      expect(jobAWithData.state).toBe('active')

      const [jobB] = await ctx.boss.fetch(ctx.schema)

      expect(jobB).toBeTruthy()

      assertTruthy(jobBId)
      const jobBWithData = await ctx.boss.getJobById(ctx.schema, jobBId)

      assertTruthy(jobBWithData)
      expect(jobBWithData.state).toBe('active')

      const jobA3Id = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a' })

      expect(jobA3Id).toBeTruthy()

      const [jobA3] = await ctx.boss.fetch(ctx.schema)

      expect(jobA3).toBeFalsy()
    })

    it(`stately policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...ctx.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      ctx.boss = await helper.start(config)

      await ctx.boss.createQueue(ctx.schema, { policy: 'stately', partition })

      // put singleton key 'a' into active state
      await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await ctx.boss.fetch(ctx.schema)
      expect(jobA).toBeTruthy()

      // then, create another job in the ctx.schema for 'a'
      const jobA2Id = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })
      expect(jobA2Id).toBeTruthy()

      // now, ctx.schema a job for 'b', and attempt to fetch it
      const jobBId = await ctx.boss.send(ctx.schema, null, { singletonKey: 'b', retryLimit: 1 })
      expect(jobBId).toBeTruthy()

      const [jobB1] = await ctx.boss.fetch(ctx.schema)
      expect(jobB1).toBe(undefined)

      await ctx.boss.supervise()
      await delay(1500)

      const [jobB] = await ctx.boss.fetch(ctx.schema)
      expect(jobB).toBeTruthy()
    })

    it(`singleton policy with singletonKey should not block other values if one is blocked using partition=${partition}`, async function () {
      const config = {
        ...ctx.bossConfig,
        noDefault: true,
        queueCacheIntervalSeconds: 1,
        monitorIntervalSeconds: 1
      }
      ctx.boss = await helper.start(config)

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton', partition })

      // put singleton key 'a' into active state
      await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })
      const [jobA] = await ctx.boss.fetch(ctx.schema)
      expect(jobA).toBeTruthy()

      // then, create another job in the ctx.schema for 'a'
      const jobA2Id = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })
      expect(jobA2Id).toBeTruthy()

      // now, ctx.schema a job for 'b', and attempt to fetch it
      const jobBId = await ctx.boss.send(ctx.schema, null, { singletonKey: 'b', retryLimit: 1 })
      expect(jobBId).toBeTruthy()

      const [jobB1] = await ctx.boss.fetch(ctx.schema)
      expect(jobB1).toBe(undefined)

      await ctx.boss.supervise()
      await delay(1500)

      const [jobB] = await ctx.boss.fetch(ctx.schema)
      expect(jobB).toBeTruthy()
    })

    it(`singleton policy with multiple singletonKeys in the ctx.schema should only promote 1 of each keep up to the requested batch size using partition=${partition}`, async function () {
      const config = {
        ...ctx.bossConfig,
        noDefault: true
      }

      ctx.boss = await helper.start(config)

      await ctx.boss.createQueue(ctx.schema, { policy: 'singleton', partition })

      await ctx.boss.send(ctx.schema, null)
      await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })
      await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })
      await ctx.boss.send(ctx.schema, null, { singletonKey: 'b', retryLimit: 1 })

      const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 4, includeMetadata: true })

      expect(jobs.length).toBe(3)
      expect(jobs.find(i => i.singletonKey === 'a')).toBeTruthy()
      expect(jobs.find(i => i.singletonKey === 'b')).toBeTruthy()

      await ctx.boss.complete(ctx.schema, jobs.map(i => i.id))

      const [job3] = await ctx.boss.fetch(ctx.schema, { includeMetadata: true })
      expect(job3.singletonKey).toBe('a')
    })

    it(`exclusive policy only allows 1 active,retry,created job using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'exclusive', partition })

      const jobId1 = await ctx.boss.send(ctx.schema, null, { retryLimit: 1 })

      expect(jobId1).toBeTruthy()

      // it won't add a second job while the first is in created state
      const blockedId = await ctx.boss.send(ctx.schema)

      expect(blockedId).toBe(null)

      const [job1] = await ctx.boss.fetch(ctx.schema)

      await ctx.boss.fail(ctx.schema, job1.id)

      assertTruthy(jobId1)
      const job1WithData = await ctx.boss.getJobById(ctx.schema, jobId1)

      assertTruthy(job1WithData)
      expect(job1WithData.state).toBe('retry')

      // trying to send another job while one is in retry should not add the job
      const jobId2 = await ctx.boss.send(ctx.schema, null, { retryLimit: 1 })

      expect(jobId2).toBe(null)

      await ctx.boss.fetch(ctx.schema)

      const job1a = await ctx.boss.getJobById(ctx.schema, jobId1)

      assertTruthy(job1a)
      expect(job1a.state).toBe('active')

      const [blockedSecondActive] = await ctx.boss.fetch(ctx.schema)

      expect(blockedSecondActive).toBeFalsy()

      // We fail the job again, this time it goes to failed state
      await ctx.boss.fail(ctx.schema, jobId1)

      // sending a new job should work now that the first job is failed
      const newJobId = await ctx.boss.send(ctx.schema)
      expect(newJobId).toBeTruthy()
    })

    it(`exclusive policy should be extended with singletonKey using partition=${partition}`, async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

      await ctx.boss.createQueue(ctx.schema, { policy: 'exclusive', partition })

      const jobAId = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobAId).toBeTruthy()

      const jobBId = await ctx.boss.send(ctx.schema, null, { singletonKey: 'b', retryLimit: 1 })

      expect(jobBId).toBeTruthy()

      const jobA2Id = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a', retryLimit: 1 })

      expect(jobA2Id).toBe(null)

      const [jobA] = await ctx.boss.fetch(ctx.schema)

      await ctx.boss.fail(ctx.schema, jobA.id)

      assertTruthy(jobAId)
      let jobAWithData = await ctx.boss.getJobById(ctx.schema, jobAId)

      assertTruthy(jobAWithData)
      expect(jobAWithData.state).toBe('retry')

      await ctx.boss.fetch(ctx.schema)

      jobAWithData = await ctx.boss.getJobById(ctx.schema, jobAId)

      assertTruthy(jobAWithData)
      expect(jobAWithData.state).toBe('active')

      const [jobB] = await ctx.boss.fetch(ctx.schema)

      expect(jobB).toBeTruthy()

      assertTruthy(jobBId)
      const jobBWithData = await ctx.boss.getJobById(ctx.schema, jobBId)

      assertTruthy(jobBWithData)
      expect(jobBWithData.state).toBe('active')

      // cannot send another 'a' job while one is active
      const jobA3Id = await ctx.boss.send(ctx.schema, null, { singletonKey: 'a' })

      expect(jobA3Id).toBeFalsy()

      const [jobA3] = await ctx.boss.fetch(ctx.schema)

      expect(jobA3).toBeFalsy()
    })
  })
})
