const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')
const PgBoss = require('../')

describe('work', function () {
  it('should fail with no arguments', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.work()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if no callback provided', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.work('foo')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail if options is not an object', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.work('foo', () => {}, 'nope')
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('offWork should fail without a name', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.offWork()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should honor a custom new job check interval', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const newJobCheckIntervalSeconds = 1
    const timeout = 5000
    let processCount = 0
    const jobCount = 10

    for (let i = 0; i < jobCount; i++) {
      await boss.send(queue)
    }

    await boss.work(queue, { newJobCheckIntervalSeconds }, () => processCount++)

    await delay(timeout)

    assert.strictEqual(processCount, timeout / 1000 / newJobCheckIntervalSeconds)
  })

  it('should honor when a worker is notified', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let processCount = 0
    const newJobCheckIntervalSeconds = 5

    await boss.send(queue)

    const workerId = await boss.work(queue, { newJobCheckIntervalSeconds }, () => processCount++)
    await delay(100)
    assert.strictEqual(processCount, 1)
    await boss.send(queue)

    boss.notifyWorker(workerId)

    await delay(100)
    assert.strictEqual(processCount, 2)
  })

  it('should remove a worker', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let receivedCount = 0

    boss.work(queue, async () => {
      receivedCount++
      await boss.offWork(queue)
    })

    await boss.send(queue)
    await boss.send(queue)

    await delay(5000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should remove a worker by id', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let receivedCount = 0

    await boss.send(queue)
    await boss.send(queue)

    const id = await boss.work(queue, { newJobCheckInterval: 500 }, async () => {
      receivedCount++
      await boss.offWork({ id })
    })

    await delay(2000)

    assert.strictEqual(receivedCount, 1)
  })

  it('should handle a batch of jobs via teamSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-teamSize'
    const teamSize = 4

    let processCount = 0

    for (let i = 0; i < teamSize; i++) {
      await boss.send(queue)
    }

    return new Promise((resolve, reject) => {
      boss.work(queue, { teamSize }, async () => {
        processCount++

        // test would time out if it had to wait for 4 fetch intervals
        if (processCount === teamSize) {
          resolve()
        }
      }).catch(reject)
    })
  })

  it('should apply teamConcurrency option', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-teamConcurrency'
    const teamSize = 4
    const teamConcurrency = 4

    let processCount = 0

    for (let i = 0; i < teamSize; i++) {
      await boss.send(queue)
    }

    return new Promise((resolve) => {
      boss.work(queue, { teamSize, teamConcurrency }, async () => {
        processCount++

        if (processCount === teamSize) {
          resolve()
        }

        // test would time out if it had to wait for each handler to resolve
        await delay(4000)
      })
    })
  })

  it('should handle a batch of jobs via batchSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-batchSize'
    const batchSize = 4

    for (let i = 0; i < batchSize; i++) {
      await boss.send(queue)
    }

    return new Promise((resolve) => {
      boss.work(queue, { batchSize }, async jobs => {
        assert.strictEqual(jobs.length, batchSize)
        resolve()
      })
    })
  })

  it('batchSize should auto-complete the jobs', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue, null, { onComplete: true })

    await new Promise((resolve) => {
      boss.work(queue, { batchSize: 1 }, async jobs => {
        assert.strictEqual(jobs.length, 1)
        resolve()
      })
    })

    await delay(2000)

    const result = await boss.fetchCompleted(queue)

    assert(result)
  })

  it('returning promise applies backpressure', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'backpressure'

    const jobCount = 4
    let processCount = 0

    for (let i = 0; i < jobCount; i++) {
      await boss.send(queue)
    }

    await boss.work(queue, async () => {
      // delay slows down process fetch
      await delay(2000)
      processCount++
    })

    await delay(7000)

    assert(processCount < jobCount)
  })

  it('top up jobs when at least one job in team is still running', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    this.timeout(1000)

    const teamSize = 4
    const teamConcurrency = 2

    let processCount = 0

    for (let i = 0; i < 6; i++) {
      await boss.send(queue)
    }

    const newJobCheckInterval = 100

    return new Promise((resolve) => {
      boss.work(queue, { teamSize, teamConcurrency, newJobCheckInterval, teamRefill: true }, async () => {
        processCount++
        if (processCount === 1) {
          // Test would timeout if all were blocked on this first
          // process
          await new Promise(resolve => setTimeout(resolve, 500))
          return
        }

        if (processCount === 6) {
          resolve()
        }
      })
    })
  })

  it('does not fetch more than teamSize', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const teamSize = 4
    const teamConcurrency = 2
    const newJobCheckInterval = 200
    let processCount = 0
    let remainCount = 0

    for (let i = 0; i < 7; i++) {
      await boss.send(queue)
    }

    // This should consume 5 jobs, all will block after the first job
    await boss.work(queue, { teamSize, teamConcurrency, newJobCheckInterval, teamRefill: true }, async () => {
      processCount++
      if (processCount > 1) await new Promise(resolve => setTimeout(resolve, 1000))
    })

    await new Promise(resolve => setTimeout(resolve, 400))

    // this should pick up the last 2 jobs
    await boss.work(queue, { teamSize, teamConcurrency, newJobCheckInterval, teamRefill: true }, async () => {
      remainCount++
    })

    await new Promise(resolve => setTimeout(resolve, 400))

    assert(remainCount === 2)
  })

  it('completion should pass string wrapped in value prop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'processCompletionString'
    const result = 'success'

    boss.work(queue, async job => result)

    await boss.send(queue)

    await delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'completed')
    assert.strictEqual(job.data.response.value, result)
  })

  it('completion via Promise resolve() should pass object payload', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, onComplete: true })

    const queue = 'processCompletionObject'
    const something = 'clever'

    boss.work(queue, async job => ({ something }))

    await boss.send(queue)

    await delay(8000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'completed')
    assert.strictEqual(job.data.response.something, something)
  })

  it('should allow multiple workers to the same queue per instance', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'multiple-workers'

    await boss.work(queue, () => {})
    await boss.work(queue, () => {})
  })

  it('should honor the includeMetadata option', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'process-includeMetadata'

    await boss.send(queue)

    return new Promise((resolve) => {
      boss.work(queue, { includeMetadata: true }, async job => {
        assert(job.startedon !== undefined)
        resolve()
      })
    })
  })

  it('should fail job at expiration without maintenance', async function () {
    const boss = this.test.boss = new PgBoss(this.test.bossConfig)

    const maintenanceTick = new Promise((resolve) => boss.on('maintenance', resolve))

    await boss.start()

    await maintenanceTick

    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { expireInSeconds: 1 })

    await boss.work(queue, () => delay(2000))

    await delay(2000)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.state, 'failed')
    assert(job.output.message.includes('handler execution exceeded'))
  })

  it('should fail a batch of jobs at expiration without maintenance', async function () {
    const boss = this.test.boss = new PgBoss(this.test.bossConfig)

    const maintenanceTick = new Promise((resolve) => boss.on('maintenance', resolve))

    await boss.start()

    await maintenanceTick

    const queue = this.test.bossConfig.schema

    const jobId1 = await boss.send(queue, null, { expireInSeconds: 1 })
    const jobId2 = await boss.send(queue, null, { expireInSeconds: 1 })

    await boss.work(queue, { batchSize: 2 }, () => delay(2000))

    await delay(2000)

    const job1 = await boss.getJobById(jobId1)
    const job2 = await boss.getJobById(jobId2)

    assert.strictEqual(job1.state, 'failed')
    assert(job1.output.message.includes('handler execution exceeded'))

    assert.strictEqual(job2.state, 'failed')
    assert(job2.output.message.includes('handler execution exceeded'))
  })

  it('should emit wip event every 2s for workers', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const firstWipEvent = new Promise(resolve => boss.once('wip', resolve))

    await boss.send(queue)
    await boss.work(queue, () => delay(1000))

    const wip1 = await firstWipEvent

    assert.strictEqual(wip1.length, 1)

    const secondWipEvent = new Promise(resolve => boss.once('wip', resolve))

    const wip2 = await secondWipEvent

    assert.strictEqual(wip2.length, 0)
  })

  it('should reject work() after stopping', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    boss.stop({ timeout: 1 })

    await delay(500)

    try {
      await boss.work(queue)
      assert(false)
    } catch (err) {
      assert(err.message.includes('stopping'))
    }
  })

  it('should allow send() after stopping', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    boss.stop({ timeout: 1 })

    await delay(500)

    await boss.send(queue)
  })
})
