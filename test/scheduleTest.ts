import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import { DateTime } from 'luxon'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'

describe('schedule', function () {
  it('should send job based on every minute expression', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *')

    await delay(4000)

    const [job] = await this.boss.fetch(this.schema)

    assert(job)
  })

  it('should send jobs based on every one second expression', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * * *')

    let numJobs = 0
    await this.boss.work(this.schema, async () => {
      numJobs++
    })

    await delay(4000)

    assert(numJobs > 1)
  })

  it('should send jobs based on every one five seconds expression', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '*/5 * * * * *')

    let numJobs = 0
    await this.boss.work(this.schema, async () => {
      numJobs++
    })

    await delay(3000)

    assert.equal(numJobs, 1)

    await delay(6000)

    assert.equal(numJobs, 2)
  }).timeout(15000)

  it("in case of restart, jobs shouldn't be overscheduled", async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '*/59 * * * * *')

    let numJobs = 0
    this.boss.work(this.schema, async () => {
      numJobs++
    })

    await delay(4000)

    assert.equal(numJobs, 1)

    // simulate restart
    await this.boss.stop({ graceful: true })
    await this.boss.start()
    await this.boss.work(this.schema, async () => {
      numJobs++
    })

    await delay(4000)

    assert.equal(numJobs, 1)
  })

  it('should set job metadata correctly', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *', {}, { retryLimit: 42, singletonSeconds: 5 })

    await delay(4000)

    const [job] = await this.boss.fetch(this.schema, { includeMetadata: true })

    assert(job)

    assert.strictEqual(job.retryLimit, 42)
    assert(job.singletonOn)
  })

  it('should fail to schedule a queue that does not exist', async function () {
    this.boss = await helper.start({ ...this.bossConfig, noDefault: true })

    await assert.rejects(async () => {
      await this.boss!.schedule(this.schema, '* * * * *')
    })
  })

  it('should send job based on every minute expression after a restart', async function () {
    this.boss = await helper.start({ ...this.bossConfig, schedule: false })

    await this.boss.schedule(this.schema, '* * * * *')

    await this.boss.stop({ graceful: false })

    this.boss = await helper.start({ ...this.bossConfig, cronWorkerIntervalSeconds: 1, schedule: true })

    await delay(4000)

    const [job] = await this.boss.fetch(this.schema)

    assert(job)

    await this.boss.stop({ graceful: false })
  })

  it('should remove previously scheduled job', async function () {
    const config = {
      ...this.bossConfig,
      cronWorkerIntervalSeconds: 1
    }
    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *')
    await this.boss.unschedule(this.schema)

    const scheduled = await this.boss.getSchedules()

    assert.strictEqual(scheduled.length, 0)
  })

  it('should send job based on current minute in UTC', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

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

    await this.boss.schedule(this.schema, cron)

    await delay(6000)

    const [job] = await this.boss.fetch(this.schema)

    assert(job)
  })

  it('should send job based on current minute in a specified time zone', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

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

    await this.boss.schedule(this.schema, cron, null, { tz })

    await delay(6000)

    const [job] = await this.boss.fetch(this.schema)

    assert(job)
  })

  it('should force a clock skew warning', async function () {
    const config = {
      ...this.bossConfig,
      schedule: true,
      __test__force_clock_skew_warning: true
    }

    // @ts-ignore
    this.boss = new PgBoss(config)

    let warningCount = 0

    this.boss.once('warning', (warning) => {
      assert(warning.message.includes('Clock skew'))
      warningCount++
    })

    await this.boss.start()

    assert.strictEqual(warningCount, 1)
  })

  it('errors during clock skew monitoring should emit', async function () {
    const config = {
      ...this.bossConfig,
      clockMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock skew monitoring'
    }

    let errorCount = 0

    this.boss = new PgBoss(config)

    this.boss.once('error', error => {
      assert.strictEqual(error.message, config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await this.boss.start()

    await delay(2000)

    assert.strictEqual(errorCount, 1)
  })

  it('errors during cron monitoring should emit', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_cron_monitoring_error: 'pg-boss mock error: cron monitoring'
    }

    let errorCount = 0

    this.boss = new PgBoss(config)

    this.boss.once('error', error => {
      assert.strictEqual(error.message, config.__test__force_cron_monitoring_error)
      errorCount++
    })

    await this.boss.start()

    await delay(2000)

    assert.strictEqual(errorCount, 1)
  })

  it('clock monitoring error handling works', async function () {
    const config = {
      ...this.bossConfig,
      schedule: true,
      clockMonitorIntervalSeconds: 1,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock monitoring'
    }

    let errorCount = 0

    this.boss = new PgBoss(config)

    this.boss.once('error', (error) => {
      assert.strictEqual(error.message, config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await this.boss.start()

    await delay(4000)

    assert.strictEqual(errorCount, 1)
  })

  it('should accept a unique key to have more than one schedule per queue', async function () {
    const config = {
      ...this.bossConfig
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *', null, { key: 'a' })
    await this.boss.schedule(this.schema, '* * * * *', null, { key: 'b' })

    const schedules = await this.boss.getSchedules()

    assert.strictEqual(schedules.length, 2)
  })

  it('should send jobs per unique key on the same cron', async function () {
    const config = {
      ...this.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *', null, { key: 'a' })
    await this.boss.schedule(this.schema, '* * * * *', null, { key: 'b' })

    await delay(4000)

    const jobs = await this.boss.fetch(this.schema, { batchSize: 2 })

    assert.strictEqual(jobs.length, 2)
  })

  it('should update a schedule with a unique key', async function () {
    const config = {
      ...this.bossConfig
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *', null, { key: 'a' })
    await this.boss.schedule(this.schema, '0 1 * * *', null, { key: 'a' })

    const schedules = await this.boss.getSchedules()

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should update a schedule without a unique key', async function () {
    const config = {
      ...this.bossConfig
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *')
    await this.boss.schedule(this.schema, '0 1 * * *')

    const schedules = await this.boss.getSchedules()

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should remove a schedule using a unique key', async function () {
    const config = {
      ...this.bossConfig
    }

    this.boss = await helper.start(config)

    await this.boss.schedule(this.schema, '* * * * *', null, { key: 'a' })
    await this.boss.schedule(this.schema, '0 1 * * *', null, { key: 'b' })

    let schedules = await this.boss.getSchedules()

    assert.strictEqual(schedules.length, 2)

    await this.boss.unschedule(this.schema, 'a')

    schedules = await this.boss.getSchedules()

    assert.strictEqual(schedules.length, 1)

    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should get schedules filtered by a queue name', async function () {
    const config = {
      ...this.bossConfig
    }

    this.boss = await helper.start(config)

    const queue2 = this.bossConfig.schema + '2'

    await this.boss.createQueue(queue2)

    await this.boss.schedule(this.schema, '* * * * *')
    await this.boss.schedule(queue2, '0 1 * * *')

    let schedules = await this.boss.getSchedules()
    assert.strictEqual(schedules.length, 2)

    schedules = await this.boss.getSchedules(queue2)

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })

  it('should get schedules filtered by a queue name and key', async function () {
    const config = {
      ...this.bossConfig
    }

    this.boss = await helper.start(config)

    const key = 'a'
    const queue2 = this.bossConfig.schema + '2'

    await this.boss.createQueue(queue2)

    await this.boss.schedule(this.schema, '* * * * *')
    await this.boss.schedule(this.schema, '0 1 * * *', null, { key })
    await this.boss.schedule(queue2, '0 2 * * *')

    let schedules = await this.boss.getSchedules()
    assert.strictEqual(schedules.length, 3)

    schedules = await this.boss.getSchedules(this.schema, key)

    assert.strictEqual(schedules.length, 1)
    assert.strictEqual(schedules[0].cron, '0 1 * * *')
  })
})
