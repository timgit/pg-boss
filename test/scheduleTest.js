const delay = require('delay')
const assert = require('assert')
const { DateTime } = require('luxon')
const helper = require('./testHelper')
const plans = require('../src/plans')
const PgBoss = require('../')

const ASSERT_DELAY = 9000

describe('schedule', function () {
  it('should publish job based on every minute expression', async function () {
    const queue = 'schedule-every-min'

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, '* * * * *')

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should accept a custom clock monitoring interval in seconds', async function () {
    const queue = 'schedule-custom-monitoring-seconds'

    const config = {
      ...this.test.bossConfig,
      clockMonitorIntervalSeconds: 1
    }

    const boss = await helper.start(config)

    await boss.schedule(queue, '* * * * *')

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('cron monitoring should restart cron if paused', async function () {
    const queue = 'schedule-cron-monitoring'

    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1
    }

    const boss = await helper.start(config)

    const { schema } = this.test.bossConfig
    const db = await helper.getDb()
    await db.executeSql(plans.clearStorage(schema))
    await db.executeSql(plans.setCronTime(schema, "now() - interval '1 hour'"))

    await boss.schedule(queue, '* * * * *')

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should publish job based on every minute expression after a restart', async function () {
    const queue = 'schedule-every-min-restart'

    let boss = await helper.start({ ...this.test.bossConfig, noScheduling: true })

    await boss.schedule(queue, '* * * * *')

    await boss.stop(this.test.bossConfig.stopOptions)

    boss = await helper.start(this.test.bossConfig)

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should remove previously scheduled job', async function () {
    const queue = 'schedule-remove'

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, '* * * * *')

    await boss.unschedule(queue)

    await boss.stop(this.test.bossConfig.stopOptions)

    const db = await helper.getDb()
    await db.executeSql(plans.clearStorage(this.test.bossConfig.schema))

    await boss.start()

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job === null)

    await boss.stop(this.test.bossConfig.stopOptions)
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

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should publish job based on current minute in a specified time zone', async function () {
    const queue = 'schedule-current-min-timezone'

    const tz = 'America/Los_Angeles'

    const nowLocal = DateTime.fromObject({ zone: tz })

    const currentMinute = nowLocal.minute
    const currentHour = nowLocal.hour

    nowLocal.plus({ minutes: 1 })

    const nextMinute = nowLocal.minute
    const nextHour = nowLocal.hour

    // using current and next minute because the clock is ticking
    const minute = `${currentMinute},${nextMinute}`
    const hour = `${currentHour},${nextHour}`

    const boss = await helper.start(this.test.bossConfig)

    await boss.schedule(queue, `${minute} ${hour} * * *`, null, { tz })

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop(this.test.bossConfig.stopOptions)
  })

  it('should force a clock skew warning', async function () {
    const boss = new PgBoss({ ...this.test.bossConfig, __test__force_clock_skew_warning: true })

    let warningCount = 0

    const warningEvent = 'warning'
    const onWarning = (warning) => {
      assert(warning.message.includes('clock skew'))
      warningCount++
    }

    process.on(warningEvent, onWarning)

    await boss.start()

    process.removeListener(warningEvent, onWarning)

    assert.strictEqual(warningCount, 1)

    await boss.stop(this.test.bossConfig.stopOptions)
  })
})
