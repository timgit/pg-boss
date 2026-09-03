import { delay } from '../src/tools.ts'
import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import { ctx } from './hooks.ts'

// An id that names no job, which is the point: last_job_id is not a foreign key, so the read path
// has to hand back whatever is stored.
const ORPHAN_JOB_ID = '00000000-0000-0000-0000-000000000001'

function firingConfig () {
  return {
    ...ctx.bossConfig,
    cronMonitorIntervalSeconds: 1,
    cronWorkerIntervalSeconds: 1,
    schedule: true
  }
}

// Poll rather than sleeping a fixed 4s: the chain is cron pass -> send-it insert -> send-it worker
// -> annotate, and a fixed sleep is both slower in the common case and short on margin when CI is
// loaded.
async function waitForLastJobIds (boss: PgBoss, count: number) {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    const schedules = await boss.getSchedules()

    if (schedules.length === count && schedules.every(({ lastJobId }) => lastJobId)) {
      return schedules
    }

    await delay(250)
  }

  throw new Error(`${count} schedule(s) did not record a last job id before the deadline`)
}

async function setLastJobId (key: string, jobId: string) {
  const db = await helper.getDb()

  await db.executeSql(
    `UPDATE ${ctx.schema}.schedule SET last_job_id = $1 WHERE name = $2 AND COALESCE(key, '') = $3`,
    [jobId, ctx.schema, key]
  )
}

describe('schedule lastJobId', function () {
  it('should be null on a schedule that has not fired', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *')

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.lastJobId).toBeNull()
  })

  it('should record the job the schedule created', async function () {
    ctx.boss = await helper.start(firingConfig())

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    const [schedule] = await waitForLastJobIds(ctx.boss, 1)

    // Read the schedule before the jobs: an every-minute schedule fires again the moment the test
    // window crosses a minute boundary, and only this order guarantees the job the row already
    // names is in the set that comes back.
    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })

    expect(jobs.map(({ id }) => id)).toContain(schedule.lastJobId)
  })

  it('should record each key independently', async function () {
    ctx.boss = await helper.start(firingConfig())

    await ctx.boss.schedule(ctx.schema, '* * * * *', { region: 'us' }, { key: 'us' })
    await ctx.boss.schedule(ctx.schema, '* * * * *', { region: 'eu' }, { key: 'eu' })

    const schedules = await waitForLastJobIds(ctx.boss, 2)

    const jobs = await ctx.boss.fetch<{ region: string }>(ctx.schema, { batchSize: 10 })
    const regionById = new Map(jobs.map(({ id, data }) => [id, data.region]))
    const byKey = Object.fromEntries(schedules.map(({ key, lastJobId }) => [key, lastJobId]))

    // Each row must name a job carrying its own payload, which is a stronger claim than the two
    // ids merely differing: a swapped attribution would still produce two distinct ids.
    expect(regionById.get(byKey.us!)).toBe('us')
    expect(regionById.get(byKey.eu!)).toBe('eu')
  })

  it('should be readable through getSchedules by queue and key', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *', null, { key: 'a' })
    await ctx.boss.schedule(ctx.schema, '0 4 * * *', null, { key: 'b' })

    await setLastJobId('a', ORPHAN_JOB_ID)

    const [schedule] = await ctx.boss.getSchedules(ctx.schema, 'a')

    expect(schedule.lastJobId).toBe(ORPHAN_JOB_ID)

    // the key-scoped read must not hand back a sibling key's run
    const [sibling] = await ctx.boss.getSchedules(ctx.schema, 'b')

    expect(sibling.lastJobId).toBeNull()
  })

  it('should survive a schedule update', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '* * * * *')

    await setLastJobId('', ORPHAN_JOB_ID)

    // re-scheduling is an upsert of the definition, not a reset of the run history
    await ctx.boss.schedule(ctx.schema, '0 3 * * *')

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.cron).toBe('0 3 * * *')
    expect(schedule.lastJobId).toBe(ORPHAN_JOB_ID)
  })

  it('should expose createdOn and updatedOn in camelCase', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, schedule: false })

    await ctx.boss.schedule(ctx.schema, '0 3 * * *')

    const [schedule] = await ctx.boss.getSchedules()

    expect(schedule.createdOn).toBeInstanceOf(Date)
    expect(schedule.updatedOn).toBeInstanceOf(Date)
  })
})
