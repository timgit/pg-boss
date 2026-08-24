import { delay } from '../src/tools.ts'
import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'

describe('failure', function () {
  it('should reject missing id argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.fail()
    }).rejects.toThrow()
  })

  it('should fail a job when requested', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    await ctx.boss.fail(ctx.schema, job.id)
  })

  it('should fail a batch of jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 3 })

    const result = await ctx.boss.fail(ctx.schema, jobs.map(job => job.id))

    expect(result.jobs.length).toBe(3)
  })

  it('should fail a batch of jobs with a data arg', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const message = 'some error'

    await Promise.all([
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema),
      ctx.boss.send(ctx.schema)
    ])

    const jobs = await ctx.boss.fetch(ctx.schema, { batchSize: 3 })

    await ctx.boss.fail(ctx.schema, jobs.map(job => job.id), new Error(message))

    const results = await Promise.all(jobs.map(job => ctx.boss!.getJobById(ctx.schema, job.id)))

    // @ts-ignore
    expect(results.every(i => i!.output.message === message)).toBeTruthy()
  })

  it('should preserve nested objects within a payload that is an instance of Error', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const failPayload = new Error('Something went wrong')
    // @ts-ignore
    failPayload.some = { deeply: { nested: { reason: 'nuna' } } }

    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId, failPayload)

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    expect(job?.output).toBeTruthy()

    // @ts-ignore
    expect(job.output.some.deeply.nested.reason).toBe(failPayload.some.deeply.nested.reason)
  })

  it('failure via Promise reject() should pass string wrapped in value prop', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const failPayload = 'mah error'

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, () => Promise.reject(failPayload))

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { value: string }).value).toBe(failPayload)
  })

  it('failure via Promise reject() should pass object payload', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const something = 'clever'

    const spy = ctx.boss.getSpy(ctx.schema)
    const errorResponse = new Error('custom error')
    // @ts-ignore
    errorResponse.something = something

    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, () => Promise.reject(errorResponse))

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { something: string }).something).toBe(something)
  })

  it('failure with Error object should be saved in the job', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })
    const message = 'a real error!'

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    await ctx.boss.work(ctx.schema, async () => { throw new Error(message) })

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { message: string }).message.includes(message)).toBeTruthy()
  })

  helper.itPglite('should fail a job with custom connection', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)

    const [job] = await ctx.boss.fetch(ctx.schema)

    let called = false
    const _db = await helper.getDb()
    const db = {
      // @ts-ignore
      async executeSql (sql, values) {
        called = true
        // @ts-ignore
        return _db.pool.query(sql, values)
      }
    }

    await ctx.boss.fail(ctx.schema, job.id, null, { db })

    expect(called).toBe(true)
  })

  it('failure with circular payload should be safely serialized', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, __test__enableSpies: true })

    const spy = ctx.boss.getSpy(ctx.schema)
    const jobId = await ctx.boss.send(ctx.schema)

    expect(jobId).toBeTruthy()

    const message = 'mhmm'

    await ctx.boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async () => {
      const err = { message }
      // @ts-ignore
      err.myself = err
      throw err
    })

    assertTruthy(jobId)
    await spy.waitForJobWithId(jobId, 'failed')

    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)
    expect((job.output as { message: string }).message).toBe(message)
  })

  it('dead letter queues are working', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0 })

    expect(jobId).toBeTruthy()

    await ctx.boss.fetch(ctx.schema)
    assertTruthy(jobId)
    await ctx.boss.fail(ctx.schema, jobId)

    const [job] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)

    expect(job.data.key).toBe(ctx.schema)

    const dlqJob = await ctx.boss.getJobById(deadLetter, job.id)
    assertTruthy(dlqJob)
    expect(dlqJob.sourceName).toBe(ctx.schema)
    expect(dlqJob.sourceId).toBe(jobId)
    expect(dlqJob.sourceCreatedOn).toBeTruthy()
    expect(dlqJob.sourceRetryCount).toBe(0)
  })

  it('dead letter preserves singleton_key but takes heartbeat_seconds from the DLQ queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter, { heartbeatSeconds: 50 })
    await ctx.boss.createQueue(ctx.schema, { deadLetter, heartbeatSeconds: 30 })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0, singletonKey: 'sk', heartbeatSeconds: 40 })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId)

    // read the DLQ job's raw columns without fetching (which would activate it)
    const dlq = await helper.findJobs(ctx.schema, 'name = $1 and source_id = $2', [deadLetter, jobId])
    expect(dlq.rows.length).toBe(1)
    expect(dlq.rows[0].singleton_key).toBe('sk')
    // job identity (singleton_key) travels; queue config does not. The copy is worked by the
    // DLQ queue's consumers, so it runs under the DLQ queue's heartbeat, matching how
    // expire_seconds/retry/retention are already sourced there. The source job's per-send
    // heartbeatSeconds (40) and the source queue's (30) both lose.
    expect(dlq.rows[0].heartbeat_seconds).toBe(50)
  })

  it('dead letter inherits the DLQ queue expire_seconds instead of the column default', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    // DLQ configured with a long expiration; a dead-lettered job must get THIS, not the 900s default.
    await ctx.boss.createQueue(deadLetter, { expireInSeconds: 3600 })
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId)

    const dlq = await helper.findJobs(ctx.schema, 'name = $1 and source_id = $2', [deadLetter, jobId])
    expect(dlq.rows.length).toBe(1)
    expect(dlq.rows[0].expire_seconds).toBe(3600)
  })

  it('redrive tolerates destination policy collisions instead of aborting the batch', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    // short policy: at most one job in the created state per queue (job_i1). Two dead-lettered jobs
    // redriving back here both insert as created and collide; without ON CONFLICT DO NOTHING the
    // whole redrive statement aborts and the jobs are stranded in the DLQ forever.
    await ctx.boss.createQueue(ctx.schema, { deadLetter, policy: 'short', retryLimit: 0 })

    const id1 = await ctx.boss.send(ctx.schema, { n: 1 })
    assertTruthy(id1)
    await ctx.boss.fetch(ctx.schema) // id1 -> active, frees the created slot

    const id2 = await ctx.boss.send(ctx.schema, { n: 2 })
    assertTruthy(id2)
    await ctx.boss.fetch(ctx.schema) // id2 -> active

    await ctx.boss.fail(ctx.schema, id1)
    await ctx.boss.fail(ctx.schema, id2)

    // both jobs now sit in the DLQ; redrive routes both back to the short source queue
    const moved = await ctx.boss.redrive(deadLetter)
    expect(moved).toBe(1)

    // the DLQ is drained either way (the colliding row is dropped, not restored)
    const movedAgain = await ctx.boss.redrive(deadLetter)
    expect(movedAgain).toBe(0)
  })

  it('redrive moves a dead-lettered job back to its source queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)
    // fail() routes the job to the dead letter queue synchronously, leaving it in the created
    // state. Don't fetch from the DLQ here — that would activate it and make it ineligible.
    await ctx.boss.fail(ctx.schema, jobId)

    const moved = await ctx.boss.redrive(deadLetter)
    expect(moved).toBe(1)

    // dead letter queue is now drained
    const movedAgain = await ctx.boss.redrive(deadLetter)
    expect(movedAgain).toBe(0)

    // reappears on the source queue as a fresh job
    const [redriven] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, ctx.schema)
    expect(redriven.data.key).toBe(ctx.schema)
    expect(redriven.id).not.toBe(jobId)

    const redrivenMeta = await ctx.boss.getJobById(ctx.schema, redriven.id)
    assertTruthy(redrivenMeta)
    expect(redrivenMeta.retryCount).toBe(0)
    expect(redrivenMeta.sourceName).toBeNull()
    // send() stamps dead_letter from the destination queue; redrive must do the same so a
    // subsequent terminal failure still copies into the DLQ (fail uses job.dead_letter).
    expect(redrivenMeta.deadLetter).toBe(deadLetter)
  })

  it('redrive stamps deadLetter so a second failure returns to the DLQ', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    // retryLimit on the queue (not just send) so redrive inherits a terminal-on-first-fail config
    await ctx.boss.createQueue(ctx.schema, { deadLetter, retryLimit: 0 })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId)

    expect(await ctx.boss.redrive(deadLetter)).toBe(1)

    const [redriven] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, ctx.schema)
    expect(redriven.data.key).toBe(ctx.schema)

    // without dead_letter on the redriven row this stays failed on the source queue forever
    await ctx.boss.fail(ctx.schema, redriven.id)

    const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
    expect(dlqJob.data.key).toBe(ctx.schema)

    const dlqMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
    assertTruthy(dlqMeta)
    expect(dlqMeta.sourceName).toBe(ctx.schema)
    expect(dlqMeta.sourceId).toBe(redriven.id)
  })

  it('dead letter copy and redrive preserve priority and group', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, {
      retryLimit: 0,
      priority: 7,
      group: { id: 'tenant-42', tier: 'gold' }
    })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId)

    // inspect the dead letter copy without fetching it — activating it would make it
    // ineligible for the redrive below
    const dlqRows = await helper.findJobs(ctx.schema, 'name = $1', [deadLetter])
    expect(dlqRows.rows.length).toBe(1)
    expect(dlqRows.rows[0].priority).toBe(7)
    expect(dlqRows.rows[0].group_id).toBe('tenant-42')
    expect(dlqRows.rows[0].group_tier).toBe('gold')

    expect(await ctx.boss.redrive(deadLetter)).toBe(1)

    const [redriven] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, ctx.schema)
    const redrivenMeta = await ctx.boss.getJobById(ctx.schema, redriven.id)
    assertTruthy(redrivenMeta)
    // without these the job comes back at priority 0 with no group, silently escaping
    // its group concurrency cap and tier routing
    expect(redrivenMeta.priority).toBe(7)
    expect(redrivenMeta.groupId).toBe('tenant-42')
    expect(redrivenMeta.groupTier).toBe('gold')
  })

  it('dead letter copy takes heartbeatSeconds from the dead letter queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter, { heartbeatSeconds: 900 })
    await ctx.boss.createQueue(ctx.schema, { deadLetter, heartbeatSeconds: 120 })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId)

    // the copy is a job on the dead letter queue, so it is worked under that queue's config —
    // it used to inherit the source queue's heartbeat instead
    const [dlqJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)
    const dlqMeta = await ctx.boss.getJobById(deadLetter, dlqJob.id)
    assertTruthy(dlqMeta)
    expect(dlqMeta.heartbeatSeconds).toBe(900)
  })

  it('redrive takes heartbeatSeconds from the destination queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    const destination = `${ctx.schema}_dest`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(destination, { heartbeatSeconds: 900 })
    await ctx.boss.createQueue(ctx.schema, { deadLetter, heartbeatSeconds: 120 })

    const jobId = await ctx.boss.send(ctx.schema, { key: ctx.schema }, { retryLimit: 0 })
    assertTruthy(jobId)

    await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, jobId)

    expect(await ctx.boss.redrive(deadLetter, { destination })).toBe(1)

    const [destJob] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, destination)
    const destMeta = await ctx.boss.getJobById(destination, destJob.id)
    assertTruthy(destMeta)
    // every queue-config column follows the destination queue, heartbeat included —
    // it used to be copied off the dead letter row instead
    expect(destMeta.heartbeatSeconds).toBe(900)
  })

  it('redrive routes each job back to its own source queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    const queueA = `${ctx.schema}_a`
    const queueB = `${ctx.schema}_b`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(queueA, { deadLetter })
    await ctx.boss.createQueue(queueB, { deadLetter })

    const idA = await ctx.boss.send(queueA, { from: 'a' }, { retryLimit: 0 })
    const idB = await ctx.boss.send(queueB, { from: 'b' }, { retryLimit: 0 })
    assertTruthy(idA)
    assertTruthy(idB)

    await ctx.boss.fetch(queueA)
    await ctx.boss.fetch(queueB)
    await ctx.boss.fail(queueA, idA)
    await ctx.boss.fail(queueB, idB)

    const moved = await ctx.boss.redrive(deadLetter)
    expect(moved).toBe(2)

    const [jobA] = await helper.fetchWithRetry<{ from: string }>(ctx.boss, queueA)
    const [jobB] = await helper.fetchWithRetry<{ from: string }>(ctx.boss, queueB)
    expect(jobA.data.from).toBe('a')
    expect(jobB.data.from).toBe('b')
  })

  it('redrive honors destination override and sourceName filter', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    const queueA = `${ctx.schema}_a`
    const queueB = `${ctx.schema}_b`
    const destination = `${ctx.schema}_dest`
    const destDeadLetter = `${ctx.schema}_dest_dlq`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(destDeadLetter)
    await ctx.boss.createQueue(destination, { deadLetter: destDeadLetter })
    await ctx.boss.createQueue(queueA, { deadLetter })
    await ctx.boss.createQueue(queueB, { deadLetter })

    const idA = await ctx.boss.send(queueA, { from: 'a' }, { retryLimit: 0 })
    const idB = await ctx.boss.send(queueB, { from: 'b' }, { retryLimit: 0 })
    assertTruthy(idA)
    assertTruthy(idB)

    await ctx.boss.fetch(queueA)
    await ctx.boss.fetch(queueB)
    await ctx.boss.fail(queueA, idA)
    await ctx.boss.fail(queueB, idB)

    // only redrive queueA's jobs, into the override destination
    const moved = await ctx.boss.redrive(deadLetter, { destination, sourceName: queueA })
    expect(moved).toBe(1)

    const [destJob] = await helper.fetchWithRetry<{ from: string }>(ctx.boss, destination)
    expect(destJob.data.from).toBe('a')

    // the override destination's config wins, not the source queue's: the redriven job is
    // stamped with destination's deadLetter, so a second failure lands in destDeadLetter
    const destMeta = await ctx.boss.getJobById(destination, destJob.id)
    assertTruthy(destMeta)
    expect(destMeta.deadLetter).toBe(destDeadLetter)

    // queueB's job is untouched, still in the dead letter queue
    const [remaining] = await helper.fetchWithRetry<{ from: string }>(ctx.boss, deadLetter)
    expect(remaining.data.from).toBe('b')
  })

  it('redrive limit caps the number of jobs moved', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`

    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    for (let i = 0; i < 3; i++) {
      const id: string | null = await ctx.boss.send(ctx.schema, { i }, { retryLimit: 0 })
      assertTruthy(id)
      await ctx.boss.fetch(ctx.schema)
      await ctx.boss.fail(ctx.schema, id)
    }

    const movedFirst = await ctx.boss.redrive(deadLetter, { limit: 2 })
    expect(movedFirst).toBe(2)

    const movedRest = await ctx.boss.redrive(deadLetter)
    expect(movedRest).toBe(1)
  })

  it('should fail active jobs in a worker during shutdown', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const jobId = await ctx.boss.send(ctx.schema, null, { retryLimit: 1 })

    await ctx.boss.work(ctx.schema, async () => await delay(4000))

    await delay(500)

    await ctx.boss.stop({ timeout: 2000 })

    await ctx.boss.start()

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job?.id).toBe(jobId)
  })
})
