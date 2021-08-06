const delay = require('delay')
const assert = require('assert')
const { DateTime } = require('luxon')
const helper = require('./testHelper')
const plans = require('../src/plans')
const PgBoss = require('../')

const ASSERT_DELAY = 9000

describe('schedule', function () {
  it('should publish job based on every minute expression', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'schedule-every-min'

    await boss.schedule(queue, '* * * * *')

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)
  })

  it('should accept a custom clock monitoring interval in seconds', async function () {
    const config = {
      ...this.test.bossConfig,
      clockMonitorIntervalSeconds: 1
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = 'schedule-custom-monitoring-seconds'

    await boss.schedule(queue, '* * * * *')

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)
  })

  it('cron monitoring should restart cron if paused', async function () {
    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = 'schedule-cron-monitoring'

    const { schema } = this.test.bossConfig
    const db = await helper.getDb()
    await db.executeSql(plans.clearStorage(schema))
    await db.executeSql(plans.setCronTime(schema, "now() - interval '1 hour'"))

    await boss.schedule(queue, '* * * * *')

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)
  })

  it('should publish job based on every minute expression after a restart', async function () {
    const queue = 'schedule-every-min-restart'

    let boss = await helper.start({ ...this.test.bossConfig, noScheduling: true, noSupervisor: true })

    await boss.schedule(queue, '* * * * *')

    await boss.stop({ graceful: false })

    boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)

    await boss.stop({ graceful: false })
  })

  it('should remove previously scheduled job', async function () {
    const queue = 'schedule-remove'

    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })

    await boss.schedule(queue, '* * * * *')

    await boss.unschedule(queue)

    await boss.stop({ graceful: false })

    const db = await helper.getDb()
    await db.executeSql(plans.clearStorage(this.test.bossConfig.schema))

    await boss.start()

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job === null)
  })

  it('should publish job based on current minute in UTC', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = this.test.bossConfig.schema

    const nowUtc = DateTime.utc()

    const currentMinute = nowUtc.minute
    const currentHour = nowUtc.hour

    const nextUtc = nowUtc.plus({ minutes: 1 })

    const nextMinute = nextUtc.minute
    const nextHour = nextUtc.hour

    // using current and next minute because the clock is ticking
    const minute = `${currentMinute},${nextMinute}`
    const hour = `${currentHour},${nextHour}`

    const cron = `${minute} ${hour} * * *`

    await boss.schedule(queue, cron)

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)
  })

  it('should publish job based on current minute in a specified time zone', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = this.test.bossConfig.schema

    const tz = 'America/Los_Angeles'

    const nowLocal = DateTime.fromObject({}, { zone: tz })

    const currentMinute = nowLocal.minute
    const currentHour = nowLocal.hour

    const nextLocal = nowLocal.plus({ minutes: 1 })

    const nextMinute = nextLocal.minute
    const nextHour = nextLocal.hour

    // using current and next minute because the clock is ticking
    const minute = `${currentMinute},${nextMinute}`
    const hour = `${currentHour},${nextHour}`

    const cron = `${minute} ${hour} * * *`

    await boss.schedule(queue, cron, null, { tz })

    await delay(ASSERT_DELAY)

    const job = await boss.fetch(queue)

    assert(job)
  })

  it('should force a clock skew warning', async function () {
    const boss = this.test.boss = new PgBoss({ ...this.test.bossConfig, __test__force_clock_skew_warning: true })

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
  })
})
