import { expect, vi } from 'vitest'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import { PgBoss } from '../src/index.ts'
import Manager from '../src/manager.ts'
import Timekeeper from '../src/timekeeper.ts'
import { delay } from '../src/tools.ts'
import { ctx } from './hooks.ts'

describe('ops', function () {
  it('should emit error in worker', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__throw_worker: true })

    await ctx.boss.send(ctx.schema)
    await ctx.boss.work(ctx.schema, async () => {})

    await new Promise(resolve => ctx.boss!.once('error', resolve))
  })

  it('should return null from getJobById if not found', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.getJobById(ctx.schema, randomUUID())

    expect(jobId).toBeFalsy()
  })

  it('should force stop', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop({ graceful: false })
  })

  helper.itPglite('should close the connection pool', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop({ graceful: false })

    // @ts-ignore
    expect(ctx.boss.getDb().pool.totalCount).toBe(0)
  })

  helper.itPglite('should close the connection pool gracefully', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop()

    // @ts-ignore
    expect(ctx.boss.getDb().pool.totalCount).toBe(0)
  })

  it('should not close the connection pool after stop with close option', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.stop({ close: false })

    const jobId = await ctx.boss.send(ctx.schema)
    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(jobId).toBe(job.id)
  })

  it('should be able to run an arbitrary query via getDb()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const { rows } = await ctx.boss.getDb().executeSql('select 1')
    expect(rows.length).toBe(1)
  })

  it('should start and stop immediately', async function () {
    const boss = new PgBoss(ctx.bossConfig)
    await boss.start()
    await boss.stop()
  })

  it('should stop maintaining before stop resolves', async function () {
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      supervise: true,
      superviseIntervalSeconds: 1,
      __test__delay_maint_ms: 2000
    })

    // Wait for maintenance to start
    while (!ctx.boss.isMaintaining()) {
      await delay(100)
    }

    // Stop while maintenance is in progress
    await ctx.boss.stop()

    expect(ctx.boss.isMaintaining()).toBe(false)
  })

  it('should stop bam work before stop resolves', async function () {
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      noDefault: true,
      bamIntervalSeconds: 1,
      __test__bypass_bam_interval_check: true,
      __test__delay_bam_ms: 2000
    })

    // Wait for bam to start working
    while (!ctx.boss.isBamWorking()) {
      await delay(100)
    }

    // Stop while bam is in progress
    await ctx.boss.stop()

    expect(ctx.boss.isBamWorking()).toBe(false)
  })

  it('should stop clock skew check before stop resolves', async function () {
    ctx.boss = await helper.start({
      ...ctx.bossConfig,
      schedule: true,
      clockMonitorIntervalSeconds: 1,
      __test__delay_clock_skew_ms: 2000
    })

    // Wait for clock skew check to start
    while (!ctx.boss.isCheckingSkew()) {
      await delay(100)
    }

    // Stop while clock skew check is in progress
    await ctx.boss.stop()

    expect(ctx.boss.isCheckingSkew()).toBe(false)
  })

  it('should allow stop() to be retried after a shutdown failure', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    // A throw during shutdown must still reset #stoppingOn, otherwise every later stop()/start()
    // no-ops forever on the stale marker and the instance is permanently unstoppable.
    const spy = vi.spyOn(Manager.prototype, 'stop').mockRejectedValueOnce(new Error('shutdown boom'))

    await expect(ctx.boss.stop()).rejects.toThrow('shutdown boom')

    spy.mockRestore()

    const stopped = new Promise<void>(resolve => ctx.boss!.once('stopped', () => resolve()))
    await ctx.boss.stop()
    await stopped
  })

  it('should tear down subsystems and stay restartable after a start() failure', async function () {
    const resourcesBefore = process.getActiveResourcesInfo()

    ctx.boss = new PgBoss({ ...ctx.bossConfig, schedule: true })

    // #stopped is cleared at the very top of start() (before any subsystem starts), so a mid-start
    // throw still leaves the subsystems that DID start (manager's queueCacheInterval/wipInterval)
    // reachable by stop(). Previously #stopped stayed true through start(), so stop() no-oped and
    // those timers leaked, wedging the instance permanently unstoppable.
    const spy = vi.spyOn(Timekeeper.prototype, 'start').mockRejectedValueOnce(new Error('start boom'))

    await expect(ctx.boss.start()).rejects.toThrow('start boom')

    spy.mockRestore()

    // stop() must tear down what did start rather than no-oping — no leaked timers
    await ctx.boss.stop()
    await new Promise(resolve => setImmediate(resolve))
    expect(process.getActiveResourcesInfo().length).toBeLessThanOrEqual(resourcesBefore.length)

    // ...and a fresh start must then succeed and be operational
    await ctx.boss.start()
    await ctx.boss.createQueue(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)
    expect(jobId).toBeTruthy()
    await ctx.boss.stop()
  })

  it('should dedupe concurrent start() calls to one in-flight promise', async function () {
    ctx.boss = new PgBoss(ctx.bossConfig)

    // The second start() sees #startingPromise already set and returns it, rather than kicking off
    // a second #doStart — both callers resolve to the same instance.
    const first = ctx.boss.start()
    const second = ctx.boss.start()

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a).toBe(ctx.boss)

    await ctx.boss.stop()
  })

  it('should wait for an in-flight start() before stopping', async function () {
    ctx.boss = new PgBoss(ctx.bossConfig)

    // stop() called mid-start must await the start (so it evaluates real, settled state) instead of
    // reading #stopped mid-flight and silently no-oping while start() keeps running.
    const startP = ctx.boss.start()
    const stopP = ctx.boss.stop()

    await startP
    await stopP

    // A fresh start() must then succeed — the instance is genuinely stopped, not wedged.
    await ctx.boss.start()
    await ctx.boss.stop()
  })

  it('should wait for an in-flight stop() before starting again', async function () {
    ctx.boss = new PgBoss(ctx.bossConfig)
    await ctx.boss.start()

    // start() called mid-stop must let the teardown finish before bringing subsystems back up,
    // otherwise the two race over the same intervals/pool.
    const stopP = ctx.boss.stop()
    const startP = ctx.boss.start()

    await stopP
    await startP

    await ctx.boss.createQueue(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)
    expect(jobId).toBeTruthy()

    await ctx.boss.stop()
  })

  it('should not leave open handles after starting and stopping', async function () {
    const resourcesBefore = process.getActiveResourcesInfo()

    const boss = new PgBoss({ ...ctx.bossConfig, supervise: true, schedule: true })
    await boss.start()
    await boss.createQueue(ctx.schema)
    await boss.work(ctx.schema, async () => {})
    await boss.stop()

    // Allow a tick for cleanup
    await new Promise(resolve => setImmediate(resolve))

    const resourcesAfter = process.getActiveResourcesInfo()

    // Check that resources didn't increase (no leaks)
    expect(resourcesAfter.length).toBeLessThanOrEqual(resourcesBefore.length)
  })
})
