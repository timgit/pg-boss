import { delay } from '../src/tools.ts'
import { expect } from 'vitest'
import { DateTime } from 'luxon'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import { testContext } from './hooks.ts'

describe('schedule', function () {
  it('should send job based on every minute expression', async function () {
    const config = {
      ...testContext.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *')

    await delay(4000)

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job).toBeTruthy()
  })

  it('should set job metadata correctly', async function () {
    const config = {
      ...testContext.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *', {}, { retryLimit: 42, singletonSeconds: 5 })

    await delay(4000)

    const [job] = await testContext.boss.fetch(testContext.schema, { includeMetadata: true })

    expect(job).toBeTruthy()
    expect(job.retryLimit).toBe(42)
    expect(job.singletonOn).toBeTruthy()
  })

  it('should fail to schedule a queue that does not exist', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, noDefault: true })

    await expect(async () => {
      await testContext.boss!.schedule(testContext.schema, '* * * * *')
    }).rejects.toThrow()
  })

  it('should send job based on every minute expression after a restart', async function () {
    testContext.boss = await helper.start({ ...testContext.bossConfig, schedule: false })

    await testContext.boss.schedule(testContext.schema, '* * * * *')

    await testContext.boss.stop({ graceful: false })

    testContext.boss = await helper.start({ ...testContext.bossConfig, cronWorkerIntervalSeconds: 1, schedule: true })

    await delay(4000)

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job).toBeTruthy()

    await testContext.boss.stop({ graceful: false })
  })

  it('should remove previously scheduled job', async function () {
    const config = {
      ...testContext.bossConfig,
      cronWorkerIntervalSeconds: 1
    }
    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *')
    await testContext.boss.unschedule(testContext.schema)

    const scheduled = await testContext.boss.getSchedules()

    expect(scheduled.length).toBe(0)
  })

  it('should send job based on current minute in UTC', async function () {
    const config = {
      ...testContext.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    testContext.boss = await helper.start(config)

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

    await testContext.boss.schedule(testContext.schema, cron)

    await delay(6000)

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job).toBeTruthy()
  })

  it('should send job based on current minute in a specified time zone', async function () {
    const config = {
      ...testContext.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    testContext.boss = await helper.start(config)

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

    await testContext.boss.schedule(testContext.schema, cron, null, { tz })

    await delay(6000)

    const [job] = await testContext.boss.fetch(testContext.schema)

    expect(job).toBeTruthy()
  })

  it('should force a clock skew warning', async function () {
    const config = {
      ...testContext.bossConfig,
      schedule: true,
      __test__force_clock_skew_warning: true
    }

    // @ts-ignore
    testContext.boss = new PgBoss(config)

    let warningCount = 0

    testContext.boss.once('warning', (warning) => {
      expect(warning.message).toContain('Clock skew')
      warningCount++
    })

    await testContext.boss.start()

    expect(warningCount).toBe(1)
  })

  it('errors during clock skew monitoring should emit', async function () {
    const config = {
      ...testContext.bossConfig,
      clockMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock skew monitoring'
    }

    let errorCount = 0

    testContext.boss = new PgBoss(config)

    testContext.boss.on('error', error => {
      expect(error.message).toBe(config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await testContext.boss.start()

    await delay(2000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })

  it('errors during cron monitoring should emit', async function () {
    const config = {
      ...testContext.bossConfig,
      cronMonitorIntervalSeconds: 1,
      schedule: true,
      __test__force_cron_monitoring_error: 'pg-boss mock error: cron monitoring'
    }

    let errorCount = 0

    testContext.boss = new PgBoss(config)

    testContext.boss.on('error', error => {
      expect(error.message).toBe(config.__test__force_cron_monitoring_error)
      errorCount++
    })

    await testContext.boss.start()

    await delay(2000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })

  it('clock monitoring error handling works', async function () {
    const config = {
      ...testContext.bossConfig,
      schedule: true,
      clockMonitorIntervalSeconds: 1,
      __test__force_clock_monitoring_error: 'pg-boss mock error: clock monitoring'
    }

    let errorCount = 0

    testContext.boss = new PgBoss(config)

    testContext.boss.on('error', (error) => {
      expect(error.message).toBe(config.__test__force_clock_monitoring_error)
      errorCount++
    })

    await testContext.boss.start()

    await delay(4000)

    expect(errorCount).toBeGreaterThanOrEqual(1)
  })

  it('should accept a unique key to have more than one schedule per queue', async function () {
    const config = {
      ...testContext.bossConfig
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *', null, { key: 'a' })
    await testContext.boss.schedule(testContext.schema, '* * * * *', null, { key: 'b' })

    const schedules = await testContext.boss.getSchedules()

    expect(schedules.length).toBe(2)
  })

  it('should send jobs per unique key on the same cron', async function () {
    const config = {
      ...testContext.bossConfig,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      schedule: true
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *', null, { key: 'a' })
    await testContext.boss.schedule(testContext.schema, '* * * * *', null, { key: 'b' })

    await delay(4000)

    const jobs = await testContext.boss.fetch(testContext.schema, { batchSize: 2 })

    expect(jobs.length).toBe(2)
  })

  it('should update a schedule with a unique key', async function () {
    const config = {
      ...testContext.bossConfig
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *', null, { key: 'a' })
    await testContext.boss.schedule(testContext.schema, '0 1 * * *', null, { key: 'a' })

    const schedules = await testContext.boss.getSchedules()

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should update a schedule without a unique key', async function () {
    const config = {
      ...testContext.bossConfig
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *')
    await testContext.boss.schedule(testContext.schema, '0 1 * * *')

    const schedules = await testContext.boss.getSchedules()

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should remove a schedule using a unique key', async function () {
    const config = {
      ...testContext.bossConfig
    }

    testContext.boss = await helper.start(config)

    await testContext.boss.schedule(testContext.schema, '* * * * *', null, { key: 'a' })
    await testContext.boss.schedule(testContext.schema, '0 1 * * *', null, { key: 'b' })

    let schedules = await testContext.boss.getSchedules()

    expect(schedules.length).toBe(2)

    await testContext.boss.unschedule(testContext.schema, 'a')

    schedules = await testContext.boss.getSchedules()

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should get schedules filtered by a queue name', async function () {
    const config = {
      ...testContext.bossConfig
    }

    testContext.boss = await helper.start(config)

    const queue2 = testContext.bossConfig.schema + '2'

    await testContext.boss.createQueue(queue2)

    await testContext.boss.schedule(testContext.schema, '* * * * *')
    await testContext.boss.schedule(queue2, '0 1 * * *')

    let schedules = await testContext.boss.getSchedules()
    expect(schedules.length).toBe(2)

    schedules = await testContext.boss.getSchedules(queue2)

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })

  it('should get schedules filtered by a queue name and key', async function () {
    const config = {
      ...testContext.bossConfig
    }

    testContext.boss = await helper.start(config)

    const key = 'a'
    const queue2 = testContext.bossConfig.schema + '2'

    await testContext.boss.createQueue(queue2)

    await testContext.boss.schedule(testContext.schema, '* * * * *')
    await testContext.boss.schedule(testContext.schema, '0 1 * * *', null, { key })
    await testContext.boss.schedule(queue2, '0 2 * * *')

    let schedules = await testContext.boss.getSchedules()
    expect(schedules.length).toBe(3)

    schedules = await testContext.boss.getSchedules(testContext.schema, key)

    expect(schedules.length).toBe(1)
    expect(schedules[0].cron).toBe('0 1 * * *')
  })
})
