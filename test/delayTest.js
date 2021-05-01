const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')

describe('delayed jobs', function () {
  it('should wait until after an int (in seconds)', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const delaySeconds = 2
    const queue = 'wait'

    const data = { message: 'hold your horses', submitted: Date.now() }
    const options = { startAfter: delaySeconds }

    await boss.publish(queue, data, options)

    return new Promise((resolve, reject) => {
      boss.subscribe(queue, async job => {
        const start = new Date(job.data.submitted)
        const end = new Date()

        const elapsedSeconds = Math.floor((end - start) / 1000)

        await job.done()

        assert(delaySeconds >= elapsedSeconds)

        resolve()
      })
    })
  })

  it('should wait until after a date time string', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'delay-date-string'

    const date = new Date()

    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date.toISOString()

    await boss.publish(queue, null, { startAfter })

    const job = await boss.fetch(queue)

    assert.strictEqual(job, null)

    await delay(5000)

    const job2 = await boss.fetch(queue)

    assert(job2)
  })

  it('should wait until after a date object', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'delay-date-object'

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await boss.publish(queue, null, { startAfter })

    const job = await boss.fetch(queue)

    assert.strictEqual(job, null)

    await delay(2000)

    const job2 = await boss.fetch(queue)

    assert(job2)
  })

  it('should work with publishAfter() and a date object', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = 'publishAfter-date-object'

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await boss.publishAfter(queue, { something: 1 }, { retryLimit: 0 }, startAfter)

    const job = await boss.fetch(queue)

    assert.strictEqual(job, null)

    await delay(2000)

    const job2 = await boss.fetch(queue)

    assert(job2)
  })
})
