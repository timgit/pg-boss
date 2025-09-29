import assert, { strictEqual } from 'node:assert'
import PgBoss from '../src/index.js'
import { delay } from '../src/tools.ts'
import { countJobs, start } from './testHelper.js'

const states = PgBoss.states

describe('queues', () => {
  it('should create a queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
  })

  it('createQueue should work if queue already exists', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.createQueue(queue)
  })

  it('should reject a queue with invalid characters', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = `*${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (_err) {
      assert(true)
    }
  })

  it('should reject a queue that starts with a number', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = `4${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (_err) {
      assert(true)
    }
  })

  it('should reject a queue with invalid policy', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    try {
      await boss.createQueue(queue, { policy: 'something' })
      assert(false)
    } catch (_err) {
      assert(true)
    }
  })

  it('should create a queue with standard policy', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'standard' })
  })

  it('should create a queue with stately policy', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })
  })

  it('should create a queue with singleton policy', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })
  })

  it('should create a queue with short policy', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })
  })

  it('should delete and then create a queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    assert(await boss.getQueue(queue))
    await boss.deleteQueue(queue)
    await boss.createQueue(queue)
  })

  it('should delete an empty queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.send(queue)
    await boss.deleteAllJobs(queue)
    await boss.deleteQueue(queue)
  })

  it('should truncate a partitioned queue and leave other queues alone', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    const queue2 = `${queue}2`
    await boss.createQueue(queue2)
    await boss.send(queue2)

    await boss.createQueue(queue, { partition: true })
    await boss.send(queue)

    await boss.deleteAllJobs(queue)
    await boss.deleteQueue(queue)

    const { queuedCount } = await boss.getQueueStats(queue2)
    assert(queuedCount)
  })

  it('should truncate a partitioned queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { partition: true })
    await boss.send(queue)
    await boss.deleteAllJobs(queue)
    await boss.deleteQueue(queue)
  })

  it('should delete a non-empty queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.send(queue)

    try {
      await boss.deleteQueue(queue)
    } catch {
      assert(false)
    }
  })

  it('should delete all queued jobs from a queue', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const getCount = () =>
      countJobs(this.test.bossConfig.schema, 'job', 'state = $1', [
        states.created
      ])

    await boss.send(queue)

    strictEqual(await getCount(), 1)

    await boss.deleteQueuedJobs(queue)

    strictEqual(await getCount(), 0)
  })

  it('should delete all stored jobs from a queue', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const { completed, failed, cancelled } = states
    const inClause = [completed, failed, cancelled].map((s) => `'${s}'`)
    const getCount = () =>
      countJobs(this.test.bossConfig.schema, 'job', `state IN (${inClause})`)

    await boss.send(queue)
    const [job1] = await boss.fetch(queue)
    assert(job1?.id)

    await boss.complete(queue, job1.id)

    strictEqual(await getCount(), 1)

    await boss.send(queue, null, { retryLimit: 0 })
    const [job2] = await boss.fetch(queue)
    await boss.fail(queue, job2.id)

    strictEqual(await getCount(), 2)

    await boss.deleteStoredJobs(queue)

    strictEqual(await getCount(), 0)
  })

  it('getQueue() returns null when missing', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = await boss.getQueue(this.test.bossConfig.schema)
    strictEqual(queue, null)
  })

  it('getQueues() returns queues array', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue1 = `${this.test.bossConfig.schema}_1`
    const queue2 = `${this.test.bossConfig.schema}_2`

    await boss.createQueue(queue1)
    await boss.createQueue(queue2)

    const queues = await boss.getQueues()

    strictEqual(queues.length, 2)

    assert(queues.some((q) => q.name === queue1))
    assert(queues.some((q) => q.name === queue2))
  })

  it('should update queue properties', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    let deadLetter = `${queue}_dlq1`
    await boss.createQueue(deadLetter)

    const createProps = {
      policy: 'standard',
      retryLimit: 1,
      retryBackoff: true,
      retryDelayMax: 3,
      retryDelay: 1,
      expireInSeconds: 1,
      retentionSeconds: 1,
      deadLetter
    }

    await boss.createQueue(queue, createProps)

    let queueObj = await boss.getQueue(queue)

    strictEqual(queue, queueObj.name)
    strictEqual(createProps.policy, queueObj.policy)
    strictEqual(createProps.retryLimit, queueObj.retryLimit)
    strictEqual(createProps.retryBackoff, queueObj.retryBackoff)
    strictEqual(createProps.retryDelay, queueObj.retryDelay)
    strictEqual(createProps.retryDelayMax, queueObj.retryDelayMax)
    strictEqual(createProps.expireInSeconds, queueObj.expireInSeconds)
    strictEqual(createProps.retentionSeconds, queueObj.retentionSeconds)
    strictEqual(createProps.deadLetter, queueObj.deadLetter)
    assert(queueObj.createdOn)
    assert(queueObj.updatedOn)

    deadLetter = `${queue}_dlq2`
    await boss.createQueue(deadLetter)

    const updateProps = {
      policy: 'short',
      retryDelay: 2,
      retryDelayMax: null,
      retryLimit: 2,
      retryBackoff: false,
      expireInSeconds: 2,
      deadLetter
    }

    await boss.updateQueue(queue, updateProps)

    queueObj = await boss.getQueue(queue)

    strictEqual(updateProps.policy, queueObj.policy)
    strictEqual(updateProps.retryLimit, queueObj.retryLimit)
    strictEqual(updateProps.retryBackoff, queueObj.retryBackoff)
    strictEqual(updateProps.retryDelay, queueObj.retryDelay)
    strictEqual(updateProps.retryDelayMax, queueObj.retryDelayMax)
    strictEqual(updateProps.expireInSeconds, queueObj.expireInSeconds)
    strictEqual(updateProps.deadLetter, queueObj.deadLetter)
  })

  it('jobs should inherit properties from queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    const deadLetter = `${queue}_dlq`
    await boss.createQueue(deadLetter)

    const createProps = {
      retryLimit: 1,
      retryBackoff: true,
      retryDelay: 2,
      retryDelayMax: 3,
      expireInSeconds: 4,
      retentionSeconds: 4,
      deadLetter
    }

    await boss.createQueue(queue, createProps)

    const jobId = await boss.send(queue)

    const job = await boss.getJobById(queue, jobId)

    const retentionSeconds =
      (new Date(job.keepUntil) - new Date(job.createdOn)) / 1000

    strictEqual(job.retryLimit, createProps.retryLimit)
    strictEqual(job.retryBackoff, createProps.retryBackoff)
    strictEqual(job.retryDelay, createProps.retryDelay)
    strictEqual(job.retryDelayMax, createProps.retryDelayMax)
    strictEqual(job.deadLetter, createProps.deadLetter)
    strictEqual(job.expireInSeconds, createProps.expireInSeconds)
    strictEqual(retentionSeconds, createProps.retentionSeconds)
  })

  it('short policy only allows 1 job in queue', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })

    const jobId = await boss.send(queue)

    assert(jobId)

    const jobId2 = await boss.send(queue)

    strictEqual(jobId2, null)

    const [job] = await boss.fetch(queue)

    strictEqual(job.id, jobId)

    const jobId3 = await boss.send(queue)

    assert(jobId3)
  })

  it('short policy should be extended with singletonKey', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })

    const jobId = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobId)

    const jobId2 = await boss.send(queue, null, { singletonKey: 'a' })

    strictEqual(jobId2, null)

    const jobId3 = await boss.send(queue, null, { singletonKey: 'b' })

    assert(jobId3)

    const [job] = await boss.fetch(queue)

    strictEqual(job.id, jobId)

    const jobId4 = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobId4)
  })

  it('singleton policy only allows 1 active job', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })

    await boss.send(queue)

    await boss.send(queue)

    const [job1] = await boss.fetch(queue)

    const [job2] = await boss.fetch(queue)

    assert(!job2)

    await boss.complete(queue, job1.id)

    const [job3] = await boss.fetch(queue)

    assert(job3)
  })

  it('singleton policy should be extended with singletonKey', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })

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

  it('stately policy only allows 1 job per state up to active', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })

    const jobId1 = await boss.send(queue, null, { retryLimit: 1 })

    const blockedId = await boss.send(queue)

    strictEqual(blockedId, null)

    let [job1] = await boss.fetch(queue)

    await boss.fail(queue, job1.id)

    job1 = await boss.getJobById(queue, jobId1)

    strictEqual(job1.state, 'retry')

    const jobId2 = await boss.send(queue, null, { retryLimit: 1 })

    assert(jobId2)

    await boss.fetch(queue)

    const job1a = await boss.getJobById(queue, jobId1)

    strictEqual(job1a.state, 'active')

    const [blockedSecondActive] = await boss.fetch(queue)

    assert(!blockedSecondActive)
  })

  it('stately policy fails a job without retry when others are active', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema
    const deadLetter = `${queue}_dlq`

    await boss.createQueue(deadLetter)
    await boss.createQueue(queue, {
      policy: 'stately',
      deadLetter,
      retryLimit: 3
    })

    const jobId1 = await boss.send(queue, null, { expireInSeconds: 1 })
    await boss.fetch(queue)
    await boss.fail(queue, jobId1)
    const job1Data = await boss.getJobById(queue, jobId1)
    strictEqual(job1Data.state, 'retry')

    // higher priority new job should be active next
    const jobId2 = await boss.send(queue, null, {
      priority: 1,
      expireInSeconds: 1
    })
    await boss.fetch(queue)

    const jobId3 = await boss.send(queue)
    assert(jobId3)

    await boss.fail(queue, jobId2)

    const job2Data = await boss.getJobById(queue, jobId2)

    strictEqual(job2Data.state, 'failed')

    const [job2Dlq] = await boss.fetch(deadLetter)

    assert(job2Dlq)
  })

  it('stately policy should be extended with singletonKey', async function () {
    const boss = (this.test.boss = await start({
      ...this.test.bossConfig,
      noDefault: true
    }))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })

    const jobAId = await boss.send(queue, null, {
      singletonKey: 'a',
      retryLimit: 1
    })

    assert(jobAId)

    const jobBId = await boss.send(queue, null, {
      singletonKey: 'b',
      retryLimit: 1
    })

    assert(jobBId)

    const jobA2Id = await boss.send(queue, null, {
      singletonKey: 'a',
      retryLimit: 1
    })

    strictEqual(jobA2Id, null)

    let [jobA] = await boss.fetch(queue)

    await boss.fail(queue, jobA.id)

    jobA = await boss.getJobById(queue, jobAId)

    strictEqual(jobA.state, 'retry')

    await boss.fetch(queue)

    jobA = await boss.getJobById(queue, jobAId)

    strictEqual(jobA.state, 'active')

    let [jobB] = await boss.fetch(queue)

    assert(jobB)

    jobB = await boss.getJobById(queue, jobBId)

    strictEqual(jobB.state, 'active')

    const jobA3Id = await boss.send(queue, null, { singletonKey: 'a' })

    assert(jobA3Id)

    const [jobA3] = await boss.fetch(queue)

    assert(!jobA3)
  })

  it('stately policy with singletonKey should not block other values if one is blocked', async function () {
    const config = {
      ...this.test.bossConfig,
      noDefault: true,
      queueCacheIntervalSeconds: 1,
      monitorIntervalSeconds: 1
    }
    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })

    // put singleton key 'a' into active state
    await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
    const [jobA] = await boss.fetch(queue)
    assert(jobA)

    // then, create another job in the queue for 'a'
    const jobA2Id = await boss.send(queue, null, {
      singletonKey: 'a',
      retryLimit: 1
    })
    assert(jobA2Id)

    // now, queue a job for 'b', and attempt to fetch it
    const jobBId = await boss.send(queue, null, {
      singletonKey: 'b',
      retryLimit: 1
    })
    assert(jobBId)

    const [jobB1] = await boss.fetch(queue)
    strictEqual(jobB1, undefined)

    await boss.supervise()
    await delay(1500)

    const [jobB] = await boss.fetch(queue)
    assert(jobB)
  })

  it('singleton policy with singletonKey should not block other values if one is blocked', async function () {
    const config = {
      ...this.test.bossConfig,
      noDefault: true,
      queueCacheIntervalSeconds: 1,
      monitorIntervalSeconds: 1
    }
    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })

    // put singleton key 'a' into active state
    await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
    const [jobA] = await boss.fetch(queue)
    assert(jobA)

    // then, create another job in the queue for 'a'
    const jobA2Id = await boss.send(queue, null, {
      singletonKey: 'a',
      retryLimit: 1
    })
    assert(jobA2Id)

    // now, queue a job for 'b', and attempt to fetch it
    const jobBId = await boss.send(queue, null, {
      singletonKey: 'b',
      retryLimit: 1
    })
    assert(jobBId)

    const [jobB1] = await boss.fetch(queue)
    strictEqual(jobB1, undefined)

    await boss.supervise()
    await delay(1500)

    const [jobB] = await boss.fetch(queue)
    assert(jobB)
  })

  it('singleton policy with multiple singletonKeys in the queue should only promote 1 of each keep up to the requested batch size', async function () {
    const config = {
      ...this.test.bossConfig,
      noDefault: true
    }

    const boss = (this.test.boss = await start(config))
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })

    await boss.send(queue, null)
    await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
    await boss.send(queue, null, { singletonKey: 'a', retryLimit: 1 })
    await boss.send(queue, null, { singletonKey: 'b', retryLimit: 1 })

    const jobs = await boss.fetch(queue, {
      batchSize: 4,
      includeMetadata: true
    })

    strictEqual(jobs.length, 3)
    assert(jobs.find((i) => i.singletonKey === 'a'))
    assert(jobs.find((i) => i.singletonKey === 'b'))

    await boss.complete(
      queue,
      jobs.map((i) => i.id)
    )

    const [job3] = await boss.fetch(queue, { includeMetadata: true })
    strictEqual(job3.singletonKey, 'a')
  })
})
