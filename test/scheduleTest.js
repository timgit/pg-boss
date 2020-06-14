const Promise = require('bluebird')
const assert = require('assert')
const helper = require('./testHelper')
const plans = require('../src/plans')

describe('schedule', function () {
  it('should publish job based on every minute expression', async function () {
    const queue = 'schedule-every-min'

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, '* * * * *')

    await Promise.delay(5000)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop()
  })

  it('should publish job based on every minute expression after a restart', async function () {
    const queue = 'schedule-every-min-restart'

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, '* * * * *')

    await boss.stop()

    await boss.start()

    await Promise.delay(5000)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop()
  })

  it('should remove previously scheduled job', async function () {
    const queue = 'schedule-remove'

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, '* * * * *')

    await boss.unschedule(queue)

    await boss.stop()

    const db = await helper.getDb()
    await db.executeSql(plans.clearStorage(this.test.bossConfig.schema))

    await boss.start()

    await Promise.delay(5000)

    const job = await boss.fetch(queue)

    assert(job === null)

    await boss.stop()
  })

  it('should publish job based on current minute in UTC', async function () {
    const queue = 'schedule-current-min-utc'

    const now = new Date()

    const currentMinute = now.getUTCMinutes()

    now.setUTCMinutes(currentMinute + 1)

    const nextMinute = now.getUTCMinutes()

    // using current and next minute because the clock is ticking
    const minuteExpression = `${currentMinute},${nextMinute}`

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, `${minuteExpression} * * * *`)

    await Promise.delay(5000)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop()
  })

  it('should publish job based on current minute in a specified time zone', async function () {
    const queue = 'schedule-current-min-timezone'

    const tz = 'America/Los_Angeles'
    const moment = require('moment-timezone')
    const nowLocal = moment().tz(tz)

    const currentMinute = nowLocal.minutes()
    const currentHour = nowLocal.hours()

    nowLocal.minutes(currentMinute + 1)

    const nextMinute = nowLocal.minutes()
    const nextHour = nowLocal.hours()

    // using current and next minute because the clock is ticking
    const minute = `${currentMinute},${nextMinute}`
    const hour = `${currentHour},${nextHour}`

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, `${minute} ${hour} * * *`, null, { tz })

    await Promise.delay(5000)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop()
  })
})
