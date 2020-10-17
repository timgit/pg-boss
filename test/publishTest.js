const assert = require('assert')
const helper = require('./testHelper')

describe('publish', function () {
  it('should fail with no arguments', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.publish()
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should fail with a function for data', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.publish('job', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should fail with a function for options', async function () {
    const boss = await helper.start(this.test.bossConfig)

    try {
      await boss.publish('job', 'data', () => true)
      assert(false)
    } catch (err) {
      assert(err)
    } finally {
      await boss.stop()
    }
  })

  it('should accept single string argument', async function () {
    const boss = await helper.start(this.test.bossConfig)
    const queue = 'publishNameOnly'
    await boss.publish(queue)
    await boss.stop()
  })

  it('should accept job object argument with only name', async function () {
    const boss = await helper.start(this.test.bossConfig)
    const queue = 'publishqueueOnly'
    await boss.publish({ name: queue })
    await boss.stop()
  })

  it('should accept job object with name and data only', async function () {
    const queue = 'publishqueueAndData'
    const message = 'hi'

    const boss = await helper.start(this.test.bossConfig)
    await boss.publish({ name: queue, data: { message } })

    const job = await boss.fetch(queue)

    assert.strictEqual(message, job.data.message)
    await boss.stop()
  })

  it('should accept job object with name and options only', async function () {
    const queue = 'publishqueueAndOptions'
    const options = { someCrazyOption: 'whatever' }

    const boss = await helper.start(this.test.bossConfig)
    await boss.publish({ name: queue, options })

    const job = await boss.fetch(queue)

    assert.strictEqual(job.data, null)

    await boss.stop()
  })

  it('should pass a connection through to executeSql', async function () {
    const db = await helper.getDb()
    let received
    this.test.bossConfig.db = {
      executeSql: async (text, values, options) => {
        const connection = options && options.connection
        if (connection) {
          received = connection
          return connection.query(text, values)
        } else {
          return db.executeSql(text, values)
        }
      }
    }
    const boss = await helper.start(this.test.bossConfig)
    const connection = await db.pool.connect()
    try {
      await boss.publish({ name: 'passConnection', options: { connection } })
    } finally {
      connection.release()
    }

    assert(received === connection)
  })
})
