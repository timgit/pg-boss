const { delay } = require('../src/tools')
const assert = require('node:assert')
const { DateTime } = require('luxon')
const helper = require('./testHelper')
const PgBoss = require('../')

describe('schedule', function () {
  it('should send job based on every minute expression', async function () {
    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *')

    await delay(4000)

    const [job] = await boss.fetch(queue)

    assert(job)
  })

  it('should set job metadata correctly', async function () {
    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    const boss = this.test.boss = await helper.start(config)
    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *', {}, { retryLimit: 42, singletonSeconds: 5 })

    await delay(4000)

    const [job] = await boss.fetch(queue, { includeMetadata: true })

    assert(job)

    assert.strictEqual(job.retryLimit, 42)
    assert(job.singletonOn)
  })

  it('should fail to schedule a queue that does not exist', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noDefault: true })
    const queue = this.test.bossConfig.schema

    try {
      await boss.schedule(queue, '* * * * *')
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should send job based on every minute expression after a restart', async function () {
    let boss = await helper.start({ ...this.test.bossConfig, schedule: false })

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *')

    await boss.stop({ graceful: false })

    boss = await helper.start({ ...this.test.bossConfig, cronWorkerIntervalSeconds: 1, schedule: true })

    await delay(4000)

    const [job] = await boss.fetch(queue)

    assert(job)

    await boss.stop({ graceful: false })
  })

  it('should remove previously scheduled job', async function () {
    const config = {
      ...this.test.bossConfig,
      cronWorkerIntervalSeconds: 1
    }
    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *')
    await boss.unschedule(queue)

    const scheduled = await boss.getSchedules()

    assert.strictEqual(scheduled.length, 0)
  })

  it('should send job based on current minute in UTC', async function () {
    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    const nowUtc = DateTime.utc()

    const currentMinute = nowUtc.minute
    const currentHour = nowUtc.hour

    const nextUtc = nowUtc.plus({ minutes: 1 })

    const nextMinute = nextUtc.minute
    const nextHour = nextUtc.hour

    // using current and next minute because the clock is ticking
    const minute = currentMinute === nextMinute ? currentMinute : `${currentMinute},${nextMinute}`
    const hour = currentHour === nextHour ? currentHour : `${currentHour},${nextHour}`

    const cron = `${minute} ${hour} * * *`

    await boss.schedule(queue, cron)

    await delay(6000)

    const [job] = await boss.fetch(queue)

    assert(job)
  })

  it('should send job based on current minute in a specified time zone', async function () {
    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    const tz = 'America/Los_Angeles'

    const nowLocal = DateTime.fromObject({}, { zone: tz })

    const currentMinute = nowLocal.minute
    const currentHour = nowLocal.hour

    const nextLocal = nowLocal.plus({ minutes: 1 })

    const nextMinute = nextLocal.minute
    const nextHour = nextLocal.hour

    // using current and next minute because the clock is ticking
    const minute = currentMinute === nextMinute ? currentMinute : `${currentMinute},${nextMinute}`
    const hour = currentHour === nextHour ? currentHour : `${currentHour},${nextHour}`

    const cron = `${minute} ${hour} * * *`

    await boss.schedule(queue, cron, null, { tz })

    await delay(6000)

    const [job] = await boss.fetch(queue)

    assert(job)
  })

  it('should force a clock skew warning', async function () {
    const config = {
      ...this.test.bossConfig,
      schedule: true,
      __test__force_clock_skew_warning: true
    }

    const boss = this.test.boss = new PgBoss(config)

    let warningCount = 0

    boss.once('warning', (warning) => {
      assert(warning.message.includes('Clock skew'))
      warningCount++
    })

    await boss.start()

    assert.strictEqual(warningCount, 1)
  })

  it('errors during clock skew monitoring should emit', async function () {
    const config = {
      ...this.test.bossConfig,
      clockMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock skew monitoring'
    }

    let errorCount = 0

    const boss = this.test.boss = new PgBoss(config)

    boss.once('error', error => {
      assert.strictEqual(error.message, config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await boss.start()

    await delay(2000)

    assert.strictEqual(errorCount, 1)
  })

  it('errors during cron monitoring should emit', async function () {
    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_cron_monitoring_error: 'pg-boss mock error: cron monitoring'
    }

    let errorCount = 0

    const boss = this.test.boss = new PgBoss(config)

    boss.once('error', error => {
      assert.strictEqual(error.message, config.__test__force_cron_monitoring_error)
      errorCount++
    })

    await boss.start()

    await delay(2000)

    assert.strictEqual(errorCount, 1)
  })

  it('clock monitoring error handling works', async function () {
    const config = {
      ...this.test.bossConfig,
      schedule: true,
      clockMonitorIntervalSeconds: 1,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock monitoring'
    }

    let errorCount = 0

    const boss = this.test.boss = new PgBoss(config)

    boss.once('error', (error) => {
      assert.strictEqual(error.message, config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await boss.start()

    await delay(4000)

    assert.strictEqual(errorCount, 1)
  })

  it('should accept a unique key to have more than one schedule per queue', async function () {
    const config = {
      ...this.test.bossConfig
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *', null, { key: 'a' })
    await boss.schedule(queue, '* * * * *', null, { key: 'b' })

    const schedules = await boss.getSchedules()

    assert.strictEqual(schedules.length, 2)
  })

  it('should send jobs per unique key on the same cron', async function () {
    const config = {
      ...this.test.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *', null, { key: 'a' })
    await boss.schedule(queue, '* * * * *', null, { key: 'b' })

    await delay(4000)

    const jobs = await boss.fetch(queue, { batchSize: 2 })

    assert.strictEqual(jobs.length, 2)
  })

  it('should update a schedule with a unique key', async function () {
    const config = {
      ...this.test.bossConfig
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *', null, { key: 'a' })
    await boss.schedule(queue, '0 1 * * *', null, { key: 'a' })

    const schedules = await boss.getSchedules()

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should update a schedule without a unique key', async function () {
    const config = {
      ...this.test.bossConfig
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *')
    await boss.schedule(queue, '0 1 * * *')

    const schedules = await boss.getSchedules()

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should remove a schedule using a unique key', async function () {
    const config = {
      ...this.test.bossConfig
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema

    await boss.schedule(queue, '* * * * *', null, { key: 'a' })
    await boss.schedule(queue, '0 1 * * *', null, { key: 'b' })

    let schedules = await boss.getSchedules()

    assert.strictEqual(schedules.length, 2)

    await boss.unschedule(queue, 'a')

    schedules = await boss.getSchedules()

    assert.strictEqual(schedules.length, 1)

    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should get schedules filtered by a queue name', async function () {
    const config = {
      ...this.test.bossConfig
    }

    const boss = this.test.boss = await helper.start(config)

    const queue = this.test.bossConfig.schema
    const queue2 = this.test.bossConfig.schema + '2'

    await boss.createQueue(queue2)

    await boss.schedule(queue, '* * * * *')
    await boss.schedule(queue2, '0 1 * * *')

    let schedules = await boss.getSchedules()
    assert.strictEqual(schedules.length, 2)

    schedules = await boss.getSchedules(queue2)

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should get schedules filtered by a queue name and key', async function () {
    const config = {
      ...this.test.bossConfig
    }

    const boss = this.test.boss = await helper.start(config)

    const key = 'a'
    const queue = this.test.bossConfig.schema
    const queue2 = this.test.bossConfig.schema + '2'

    await boss.createQueue(queue2)

    await boss.schedule(queue, '* * * * *')
    await boss.schedule(queue, '0 1 * * *', null, { key })
    await boss.schedule(queue2, '0 2 * * *')

    let schedules = await boss.getSchedules()
    assert.strictEqual(schedules.length, 3)

    schedules = await boss.getSchedules(queue, key)

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })
})
