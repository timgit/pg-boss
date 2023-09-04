const assert = require('assert')
const helper = require('./testHelper')
const PgBoss = require('../')

describe('complete', function () {
  it('should reject missing id argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.complete()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should complete a batch of jobs', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })

    const queue = 'complete-batch'
    const batchSize = 3

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const countJobs = (state) => helper.countJobs(this.test.bossConfig.schema, 'name = $1 AND state = $2', [queue, state])

    const jobs = await boss.fetch(queue, batchSize)

    const activeCount = await countJobs(PgBoss.states.active)

    assert.strictEqual(activeCount, batchSize)

    const result = await boss.complete(jobs.map(job => job.id))

    assert.strictEqual(batchSize, result.jobs.length)
  })

  it('should store job output in job.output from complete()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'completion-data-in-job-output'

    const jobId = await boss.send(queue)

    const { id } = await boss.fetch(queue)

    assert.strictEqual(jobId, id)

    const completionData = { msg: 'i am complete' }

    await boss.complete(jobId, completionData)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.msg, completionData.msg)
  })

  it('should store job error in job.output from fail()', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'completion-data-in-job-output'

    const jobId = await boss.send(queue)

    const { id } = await boss.fetch(queue)

    assert.strictEqual(jobId, id)

    const completionError = new Error('i am complete')

    await boss.fail(jobId, completionError)

    const job = await boss.getJobById(jobId)

    assert.strictEqual(job.output.message, completionError.message)
  })

  it('should complete a batch of jobs with custom connection', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })

    const queue = 'complete-batch'
    const batchSize = 3

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const countJobs = (state) => helper.countJobs(this.test.bossConfig.schema, 'name = $1 AND state = $2', [queue, state])

    const jobs = await boss.fetch(queue, batchSize)

    const activeCount = await countJobs(PgBoss.states.active)

    assert.strictEqual(activeCount, batchSize)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        called = true
        return _db.pool.query(sql, values)
      }
    }

    const result = await boss.complete(jobs.map(job => job.id), null, { db })

    assert.strictEqual(batchSize, result.jobs.length)
    assert.strictEqual(called, true)
  })

  it.skip('should warn with an old onComplete option only once', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })

    const queue = this.test.bossConfig.schema

    let warningCount = 0

    const warningEvent = 'warning'
    const onWarning = (warning) => {
      assert(warning.message.includes('onComplete'))
      warningCount++
    }

    process.on(warningEvent, onWarning)

    await boss.send({ name: queue, options: { onComplete: true } })
    await boss.send({ name: queue, options: { onComplete: true } })
    await boss.send({ name: queue, options: { onComplete: true } })

    process.removeListener(warningEvent, onWarning)

    assert.strictEqual(warningCount, 1)
  })
})
