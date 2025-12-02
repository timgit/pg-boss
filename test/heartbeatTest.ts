import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('heartbeat', function () {
  it('should extend job timeout with heartbeat enabled', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    // expireInSeconds: 2, handler takes 3s - heartbeat at 1s keeps it alive
    const jobId = await this.boss.send(this.schema, null, { retryLimit: 0, expireInSeconds: 2 })
    assert(jobId)

    let jobCompleted = false

    await this.boss.work(this.schema, {
      heartbeat: { intervalSeconds: 1 }
    }, async () => {
      await delay(3000)
      jobCompleted = true
      return { success: true }
    })

    await delay(4000)

    assert.strictEqual(jobCompleted, true)

    const job = await this.boss.getJobById(this.schema, jobId)
    assert.strictEqual(job!.state, 'completed')
  })

  it('should emit heartbeat events', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await this.boss.send(this.schema, null, { expireInSeconds: 4 })
    assert(jobId)

    const heartbeatEvents: { name: string, jobIds: string[] }[] = []

    this.boss.on('heartbeat', (data) => {
      heartbeatEvents.push(data)
    })

    await this.boss.work(this.schema, {
      heartbeat: { intervalSeconds: 1 }
    }, async () => {
      await delay(2500)
    })

    await delay(3000)

    // Should have received at least 2 heartbeat events (at 1s interval over 2.5s)
    assert(heartbeatEvents.length >= 2, `Expected at least 2 heartbeat events, got ${heartbeatEvents.length}`)
    assert.strictEqual(heartbeatEvents[0].name, this.schema)
    assert(heartbeatEvents[0].jobIds.includes(jobId))
  })

  it('should work with heartbeat: true shorthand', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    // With heartbeat: true, interval defaults to expireInSeconds/2 = 1s
    const jobId = await this.boss.send(this.schema, null, { expireInSeconds: 2 })
    assert(jobId)

    let jobCompleted = false

    await this.boss.work(this.schema, {
      heartbeat: true
    }, async () => {
      await delay(3000)
      jobCompleted = true
    })

    await delay(4000)

    assert.strictEqual(jobCompleted, true)
  })

  it('should handle batch jobs with heartbeat', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId1 = await this.boss.send(this.schema, { num: 1 }, { expireInSeconds: 2 })
    const jobId2 = await this.boss.send(this.schema, { num: 2 }, { expireInSeconds: 2 })
    const jobId3 = await this.boss.send(this.schema, { num: 3 }, { expireInSeconds: 2 })

    assert(jobId1 && jobId2 && jobId3)

    let batchProcessed = false

    await this.boss.work(this.schema, {
      batchSize: 3,
      heartbeat: { intervalSeconds: 1 }
    }, async (jobs) => {
      assert.strictEqual(jobs.length, 3)
      await delay(3000)
      batchProcessed = true
    })

    await delay(4000)

    assert.strictEqual(batchProcessed, true)

    const job1 = await this.boss.getJobById(this.schema, jobId1)
    const job2 = await this.boss.getJobById(this.schema, jobId2)
    const job3 = await this.boss.getJobById(this.schema, jobId3)

    assert.strictEqual(job1!.state, 'completed')
    assert.strictEqual(job2!.state, 'completed')
    assert.strictEqual(job3!.state, 'completed')
  })

  it('should emit heartbeat-failed when job is externally completed', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await this.boss.send(this.schema, null, { expireInSeconds: 10 })
    assert(jobId)

    let heartbeatFailedEvent: { name: string, jobIds: string[], touchedCount: number } | null = null

    this.boss.on('heartbeat-failed', (data) => {
      heartbeatFailedEvent = data
    })

    await this.boss.work(this.schema, {
      heartbeat: { intervalSeconds: 1, abortOnFailure: false }
    }, async () => {
      // Complete the job externally while handler is running
      await delay(500)
      await this.boss.complete(this.schema, jobId)
      // Wait for heartbeat to fire and detect the job is no longer active
      await delay(1500)
    })

    await delay(3000)

    assert(heartbeatFailedEvent, 'Expected heartbeat-failed event')
    assert.strictEqual(heartbeatFailedEvent!.name, this.schema)
    assert(heartbeatFailedEvent!.jobIds.includes(jobId))
    assert.strictEqual(heartbeatFailedEvent!.touchedCount, 0)
  })

  it('should abort signal when heartbeat fails with abortOnFailure', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await this.boss.send(this.schema, null, { expireInSeconds: 10 })
    assert(jobId)

    let signalAborted = false

    await this.boss.work(this.schema, {
      heartbeat: { intervalSeconds: 1 } // abortOnFailure defaults to true
    }, async (jobs) => {
      const job = jobs[0]
      job.signal.addEventListener('abort', () => {
        signalAborted = true
      })
      // Complete the job externally while handler is running
      await delay(500)
      await this.boss.complete(this.schema, jobId)
      // Wait for heartbeat to fire and abort the signal
      await delay(1500)
    })

    await delay(3000)

    assert.strictEqual(signalAborted, true, 'Expected signal to be aborted when heartbeat fails')
  })

  it('should cleanup heartbeat timers on stop', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await this.boss.send(this.schema, null, { expireInSeconds: 10 })
    assert(jobId)

    let heartbeatCount = 0

    this.boss.on('heartbeat', () => {
      heartbeatCount++
    })

    await this.boss.work(this.schema, {
      heartbeat: { intervalSeconds: 1 }
    }, async () => {
      // Long running job
      await delay(10000)
    })

    // Wait for at least one heartbeat
    await delay(1500)
    const countBeforeStop = heartbeatCount

    assert(countBeforeStop >= 1, 'Expected at least 1 heartbeat before stop')

    // Stop should cleanup heartbeat timers
    await this.boss.stop({ graceful: false, timeout: 1000 })

    // Wait and verify no more heartbeats fire
    await delay(2000)

    assert.strictEqual(heartbeatCount, countBeforeStop, 'No heartbeats should fire after stop')
  })

  it('should emit error event on heartbeat database error', async function () {
    this.timeout(6000)

    this.boss = await helper.start({ ...this.bossConfig, monitorIntervalSeconds: 1 })

    const jobId = await this.boss.send(this.schema, null, { expireInSeconds: 10 })
    assert(jobId)

    let errorEmitted = false
    const testError = new Error('Mock database error')

    this.boss.on('error', (error) => {
      if (error.message === 'Mock database error') {
        errorEmitted = true
      }
    })

    const db = this.boss.getDb()
    const originalExecuteSql = db.executeSql.bind(db)

    try {
      await this.boss.work(this.schema, {
        heartbeat: { intervalSeconds: 1 }
      }, async () => {
        // Wait a bit then mock the database to throw on next call
        await delay(500)
        db.executeSql = async (...args: any[]) => {
          // Check if this is a touchJobs query (heartbeat)
          if (args[0]?.includes?.('expire_seconds')) {
            throw testError
          }
          return originalExecuteSql(...args)
        }
        // Wait for heartbeat to fire and hit the error
        await delay(1500)
      })

      await delay(3000)

      assert.strictEqual(errorEmitted, true, 'Expected error event from heartbeat DB failure')
    } finally {
      db.executeSql = originalExecuteSql
    }
  })
})
