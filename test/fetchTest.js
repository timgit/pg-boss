const assert = require('assert')
const helper = require('./testHelper')

describe('fetch', function () {
  it('should reject missing queue argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.fetch()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fetch a job by name manually', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    const job = await boss.fetch(queue)
    assert(queue === job.name)
    // Metadata should only be included when specifically requested
    assert(job.startedon === undefined)
  })

  it('should get a batch of jobs as an array', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const batchSize = 4

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const jobs = await boss.fetch(queue, batchSize)

    assert(jobs.length === batchSize)
    // Metadata should only be included when specifically requested
    assert(jobs[0].startedon === undefined)
  })

  it('should fetch all metadata for a single job when requested', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    const job = await boss.fetch(queue, undefined, { includeMetadata: true })
    assert(queue === job.name)
    assert(job.priority === 0)
    assert(job.state === 'active')
    assert(job.retrylimit === 0)
    assert(job.retrycount === 0)
    assert(job.retrydelay === 0)
    assert(job.retrybackoff === false)
    assert(job.startafter !== undefined)
    assert(job.startedon !== undefined)
    assert(job.singletonkey === null)
    assert(job.singletonon === null)
    assert(job.expirein.minutes === 15)
    assert(job.createdon !== undefined)
    assert(job.completedon === null)
    assert(job.keepuntil !== undefined)
  })

  it('should fetch all metadata for a batch of jobs when requested', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const batchSize = 4

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const jobs = await boss.fetch(queue, batchSize, { includeMetadata: true })
    assert(jobs.length === batchSize)

    jobs.forEach(job => {
      assert(queue === job.name)
      assert(job.priority === 0)
      assert(job.state === 'active')
      assert(job.retrylimit === 0)
      assert(job.retrycount === 0)
      assert(job.retrydelay === 0)
      assert(job.retrybackoff === false)
      assert(job.startafter !== undefined)
      assert(job.startedon !== undefined)
      assert(job.singletonkey === null)
      assert(job.singletonon === null)
      assert(job.expirein.minutes === 15)
      assert(job.createdon !== undefined)
      assert(job.completedon === null)
      assert(job.keepuntil !== undefined)
    })
  })

  it('should fetch a job with custom connection', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let calledCounter = 0
    const db = await helper.getDb()
    const options = {
      db: {
        async executeSql (sql, values) {
          calledCounter++
          return db.pool.query(sql, values)
        }
      }
    }

    await boss.send(queue, {}, options)
    const [job] = await boss.fetch(queue, 10, options)
    assert(queue === job.name)
    assert(job.startedon === undefined)
    assert.strictEqual(calledCounter, 2)
  })

  describe('enforceSingletonQueueActiveLimit option', function () {
    it('when enforceSingletonQueueActiveLimit=false, should fetch singleton queue job even if there is already an active one', async function () {
      const boss = this.test.boss = await helper.start(this.test.bossConfig)
      const queue = this.test.bossConfig.schema
      const jobOptions = { singletonKey: 'singleton_queue_active_test', useSingletonQueue: true }
      const sendArgs = [queue, {}, jobOptions]
      const fetchArgs = [queue, undefined, { enforceSingletonQueueActiveLimit: false }]

      const publish1 = await boss.send(...sendArgs)
      assert(publish1)
      const fetch1 = await boss.fetch(...fetchArgs)
      assert(fetch1)

      const publish2 = await boss.send(...sendArgs)
      assert(publish2)
      const fetch2 = await boss.fetch(...fetchArgs)
      assert(fetch2)
    })

    it('when enforceSingletonQueueActiveLimit=true, should not fetch singleton queue job if there is already an active one', async function () {
      const boss = this.test.boss = await helper.start(this.test.bossConfig)
      const queue = this.test.bossConfig.schema
      const jobOptions = { singletonKey: 'singleton_queue_active_test', useSingletonQueue: true }
      const sendArgs = [queue, {}, jobOptions]
      const fetchArgs = [queue, undefined, { enforceSingletonQueueActiveLimit: true }]

      const publish1 = await boss.send(...sendArgs)
      assert(publish1)
      const fetch1 = await boss.fetch(...fetchArgs)
      assert(fetch1)

      const publish2 = await boss.send(...sendArgs)
      assert(publish2)
      // Job 1 still active, can't fetch job 2
      const fetch2 = await boss.fetch(...fetchArgs)
      assert(fetch2 === null)

      await boss.complete(fetch1.id)
      // Job 1 no longer active, should be able to fetch job 2
      const retryFetch2 = await boss.fetch(...fetchArgs)
      assert(retryFetch2)
      assert(retryFetch2.id === publish2)
    })
  })
})
