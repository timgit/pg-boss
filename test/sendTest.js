import assert from 'node:assert'
import * as helper from './testHelper.js'

describe('send', function () {
  it('should fail with no arguments', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.send()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for data', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.send('job', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail with a function for options', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.send('job', 'data', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should accept single string argument', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
  })

  it('should accept job object argument with only name', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.send({ name: queue })
  })

  it('should accept job object with name and data only', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const message = 'hi'

    await boss.send({ name: queue, data: { message } })

    const [job] = await boss.fetch(queue)

    assert.strictEqual(message, job.data.message)
  })

  it('should accept job object with name and options only', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const options = { someCrazyOption: 'whatever' }

    await boss.send({ name: queue, options })

    const [job] = await boss.fetch(queue)

    assert.strictEqual(job.data, null)
  })

  it('should accept job object with name and custom connection', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    let called = false
    const db = await helper.getDb()
    const options = {
      db: {
        async executeSql (sql, values) {
          called = true
          return db.pool.query(sql, values)
        }
      },
      someCrazyOption: 'whatever'
    }

    await boss.send({ name: queue, options })

    const [job] = await boss.fetch(queue)

    assert.notEqual(job, null)
    assert.strictEqual(job.data, null)
    assert.strictEqual(called, true)
  })

  it('should not create job if transaction fails', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const { schema } = this.test.bossConfig
    const queue = schema

    const db = await helper.getDb()
    const client = db.pool
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.test (label VARCHAR(50))`)

    const throwError = () => { throw new Error('Error') }

    try {
      await client.query('BEGIN')
      const options = {
        db: {
          async executeSql (sql, values) {
            return client.query(sql, values)
          }
        },
        someCrazyOption: 'whatever'
      }
      const queryText = `INSERT INTO ${schema}.test(label) VALUES('Test')`
      await client.query(queryText)

      await boss.send({ name: queue, options })

      throwError()
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
    }

    const [job] = await boss.fetch(queue)

    assert(!job)
  })

  it('should create job with all properties', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const deadLetter = `${queue}_dlq`
    await boss.createQueue(deadLetter)
    await boss.updateQueue(queue, { deadLetter })

    const options = {
      priority: 1,
      retryLimit: 1,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 3,
      startAfter: new Date().toISOString(),
      expireInSeconds: 5,
      deleteAfterSeconds: 60,
      singletonKey: '123',
      retentionSeconds: 10
    }

    const keepUntil = new Date(new Date(options.startAfter).getTime() + (options.retentionSeconds * 1000)).toISOString()

    const id = await boss.send(queue, null, options)

    const job = await boss.getJobById(queue, id)

    assert.strictEqual(job.priority, options.priority, `priority input ${options.priority} didn't match job ${job.priority}`)
    assert.strictEqual(job.retryLimit, options.retryLimit, `retryLimit input ${options.retryLimit} didn't match job ${job.retryLimit}`)
    assert.strictEqual(job.retryDelay, options.retryDelay, `retryDelay input ${options.retryDelay} didn't match job ${job.retryDelay}`)
    assert.strictEqual(job.retryBackoff, options.retryBackoff, `retryBackoff input ${options.retryBackoff} didn't match job ${job.retryBackoff}`)
    assert.strictEqual(job.retryDelayMax, options.retryDelayMax, `retryDelayMax input ${options.retryDelayMax} didn't match job ${job.retryDelayMax}`)
    assert.strictEqual(new Date(job.startAfter).toISOString(), options.startAfter, `startAfter input ${options.startAfter} didn't match job ${job.startAfter}`)
    assert.strictEqual(job.expireInSeconds, options.expireInSeconds, `expireInSeconds input ${options.expireInSeconds} didn't match job ${job.expireInSeconds}`)
    assert.strictEqual(job.deleteAfterSeconds, options.deleteAfterSeconds, `deleteAfterSeconds input ${options.deleteAfterSeconds} didn't match job ${job.deleteAfterSeconds}`)
    assert.strictEqual(job.singletonKey, options.singletonKey, `name input ${options.singletonKey} didn't match job ${job.singletonKey}`)
    assert.strictEqual(new Date(job.keepUntil).toISOString(), keepUntil, `keepUntil input ${keepUntil} didn't match job ${job.keepUntil}`)
  })
})
