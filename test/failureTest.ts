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

  it('should leave a completed job in a failed batch alone', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    const [done, active] = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
    await ctx.boss.complete(ctx.schema, done.id)

    const result = await ctx.boss.fail(ctx.schema, [done.id, active.id])
    expect(result.affected).toBe(1)

    const job = await ctx.boss.getJobById(ctx.schema, done.id)
    expect(job?.state).toBe('completed')
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
    await ctx.boss.fail(ctx.schema, jobId, { message: 'card declined' })

    const [job] = await helper.fetchWithRetry<{ key: string }>(ctx.boss, deadLetter)

    expect(job.data.key).toBe(ctx.schema)

    const dlqJob = await ctx.boss.getJobById(deadLetter, job.id)
    assertTruthy(dlqJob)
    expect(dlqJob.sourceName).toBe(ctx.schema)
    expect(dlqJob.sourceId).toBe(jobId)
    expect(dlqJob.sourceCreatedOn).toBeTruthy()
    expect(dlqJob.sourceRetryCount).toBe(0)
    // The copy is a new job: the original's output is provenance, and its own output is empty
    // until it runs.
    expect(dlqJob.sourceOutput).toEqual({ message: 'card declined' })
    expect(dlqJob.output).toBeNull()
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

    // the colliding job is failed in place, so it is not a candidate again
    const movedAgain = await ctx.boss.redrive(deadLetter)
    expect(movedAgain).toBe(0)
    expect((await ctx.boss.previewRedrive(deadLetter)).total).toBe(0)
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
    // state. Don't fetch from the DLQ here. That would activate it and make it ineligible.
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

    // inspect the dead letter copy without fetching it, activating it would make it
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

    // the copy is a job on the dead letter queue, so it is worked under that queue's config,
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
    // every queue-config column follows the destination queue, heartbeat included,
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

  describe('redrive filters and previewRedrive', function () {
    // Sends each payload to `source`, fails it with no retries, and returns the
    // dead-lettered copies' ids in the order they arrived.
    async function deadLetterAll (source: string, deadLetter: string, payloads: object[]) {
      for (const data of payloads) {
        const id = await ctx.boss!.send(source, data, { retryLimit: 0 })
        assertTruthy(id)
        await ctx.boss!.fetch(source)
        await ctx.boss!.fail(source, id)
      }
      const jobs = await ctx.boss!.findJobs(deadLetter, { queued: true })
      return jobs.sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime()).map(job => job.id)
    }

    // `deadLetterRetryLimit` is set at creation rather than through updateQueue, which does not
    // run on CockroachDB.
    async function setup (deadLetterRetryLimit?: number) {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      const deadLetter = `${ctx.schema}_dlq`
      const queueA = `${ctx.schema}_a`
      const queueB = `${ctx.schema}_b`
      await ctx.boss.createQueue(deadLetter, deadLetterRetryLimit === undefined ? {} : { retryLimit: deadLetterRetryLimit })
      await ctx.boss.createQueue(queueA, { deadLetter })
      await ctx.boss.createQueue(queueB, { deadLetter })
      return { deadLetter, queueA, queueB }
    }

    it('redrives only jobs whose payload contains data', async function () {
      const { deadLetter, queueA } = await setup()
      await deadLetterAll(queueA, deadLetter, [{ tenant: 'acme', n: 1 }, { tenant: 'globex', n: 2 }, { tenant: 'acme', n: 3 }])

      expect(await ctx.boss!.redrive(deadLetter, { data: { tenant: 'acme' } })).toBe(2)

      const [left] = await ctx.boss!.findJobs<{ tenant: string }>(deadLetter, { queued: true })
      expect(left.data.tenant).toBe('globex')
    })

    it('never sweeps in jobs dead-lettered after createdBefore', async function () {
      const { deadLetter, queueA } = await setup()
      await deadLetterAll(queueA, deadLetter, [{ n: 1 }, { n: 2 }])
      const cutoff = new Date((await ctx.boss!.findJobs(deadLetter, { queued: true }))
        .reduce((max, job) => Math.max(max, job.createdOn.getTime()), 0) + 1)
      await deadLetterAll(queueA, deadLetter, [{ n: 3 }])

      // Drained in several calls with one cutoff, the way a chunked caller would.
      expect(await ctx.boss!.redrive(deadLetter, { createdBefore: cutoff, limit: 1 })).toBe(1)
      expect(await ctx.boss!.redrive(deadLetter, { createdBefore: cutoff, limit: 1 })).toBe(1)
      expect(await ctx.boss!.redrive(deadLetter, { createdBefore: cutoff, limit: 1 })).toBe(0)

      const [left] = await ctx.boss!.findJobs<{ n: number }>(deadLetter, { queued: true })
      expect(left.data.n).toBe(3)
    })

    it('redrives only the listed ids', async function () {
      const { deadLetter, queueA } = await setup()
      const ids = await deadLetterAll(queueA, deadLetter, [{ n: 1 }, { n: 2 }, { n: 3 }])

      expect(await ctx.boss!.redrive(deadLetter, { ids: [ids[0], ids[2]] })).toBe(2)

      const left = await ctx.boss!.findJobs(deadLetter, { queued: true })
      expect(left.map(job => job.id)).toEqual([ids[1]])
    })

    it('does not redrive a job the dead letter queue already failed', async function () {
      const { deadLetter, queueA } = await setup(0)
      const [id] = await deadLetterAll(queueA, deadLetter, [{ n: 1 }])
      await ctx.boss!.fetch(deadLetter)
      await ctx.boss!.fail(deadLetter, id)

      expect(await ctx.boss!.redrive(deadLetter)).toBe(0)
      expect((await ctx.boss!.previewRedrive(deadLetter)).total).toBe(0)
    })

    /**
     * Failing a job deletes and re-inserts it. Before the fix the re-insert
     * dropped the source_* columns, so a dead-lettered job that its dead letter
     * queue's worker failed once forgot where it came from and could no longer
     * be redriven.
     */
    it('keeps provenance when the dead letter queue retries a job, so it can still be redriven', async function () {
      const { deadLetter, queueA } = await setup(2)
      const [id] = await deadLetterAll(queueA, deadLetter, [{ n: 1 }])
      const before = await ctx.boss!.getJobById(deadLetter, id)
      assertTruthy(before)

      await ctx.boss!.fetch(deadLetter)
      await ctx.boss!.fail(deadLetter, id)

      const after = await ctx.boss!.getJobById(deadLetter, id)
      assertTruthy(after)
      expect(after.state).toBe('retry')
      expect(after.sourceName).toBe(queueA)
      expect(after.sourceId).toBe(before.sourceId)
      expect(after.sourceCreatedOn).toEqual(before.sourceCreatedOn)
      expect(after.sourceRetryCount).toBe(before.sourceRetryCount)

      expect(await ctx.boss!.previewRedrive(deadLetter)).toEqual({ total: 1, destinations: [{ name: queueA, count: 1 }], unroutable: 0 })
      expect(await ctx.boss!.redrive(deadLetter)).toBe(1)
    })

    it('keeps provenance on a job the dead letter queue fails terminally', async function () {
      const { deadLetter, queueA } = await setup(0)
      const [id] = await deadLetterAll(queueA, deadLetter, [{ n: 1 }])

      await ctx.boss!.fetch(deadLetter)
      await ctx.boss!.fail(deadLetter, id)

      const after = await ctx.boss!.getJobById(deadLetter, id)
      assertTruthy(after)
      expect(after.state).toBe('failed')
      expect(after.sourceName).toBe(queueA)
    })

    it('previews the fan-out, and counts what the redrive then moves', async function () {
      const { deadLetter, queueA, queueB } = await setup()
      await deadLetterAll(queueA, deadLetter, [{ tenant: 'acme' }, { tenant: 'acme' }, { tenant: 'globex' }])
      await deadLetterAll(queueB, deadLetter, [{ tenant: 'acme' }])
      // Sent straight to the dead letter queue, so it has no recorded source.
      await ctx.boss!.send(deadLetter, { tenant: 'acme' })

      const preview = await ctx.boss!.previewRedrive(deadLetter, { data: { tenant: 'acme' } })
      expect(preview).toEqual({
        total: 4,
        destinations: [{ name: queueA, count: 2 }, { name: queueB, count: 1 }],
        unroutable: 1
      })

      // The unroutable job stays behind, exactly as the preview said.
      expect(await ctx.boss!.redrive(deadLetter, { data: { tenant: 'acme' } })).toBe(3)
      expect((await ctx.boss!.previewRedrive(deadLetter, { data: { tenant: 'acme' } })).unroutable).toBe(1)
    })

    it('previews a destination override as one destination with nothing unroutable', async function () {
      const { deadLetter, queueA, queueB } = await setup()
      await deadLetterAll(queueA, deadLetter, [{ n: 1 }])
      await ctx.boss!.send(deadLetter, { n: 2 })

      expect(await ctx.boss!.previewRedrive(deadLetter, { destination: queueB })).toEqual({
        total: 2,
        destinations: [{ name: queueB, count: 2 }],
        unroutable: 0
      })
    })

    it('rejects filters that would silently match nothing or everything', async function () {
      const { deadLetter } = await setup()
      await expect(ctx.boss!.redrive(deadLetter, { ids: [] })).rejects.toThrow('ids must be a non-empty array of strings')
      await expect(ctx.boss!.previewRedrive(deadLetter, { data: [1] as unknown as object })).rejects.toThrow('data must be an object')
      await expect(ctx.boss!.redrive(deadLetter, { createdBefore: new Date('nope') })).rejects.toThrow('createdBefore must be a valid Date')
    })
  })

  // redrive has two implementations: one statement (a multi-mutation CTE), and three statements in a
  // transaction for backends that reject that (noMultiMutationCte, CockroachDB). A coverage run
  // reaches only one of them, so this block pins each with __test__distributed and runs the same
  // cases through both, which also holds them to moving the same jobs.
  for (const [path, distributed] of [['one statement', false], ['statements in a transaction', true]] as const) {
    describe(`redrive as ${path}`, function () {
      async function setup (sourceOptions: { policy?: 'short' } = {}) {
        ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true, __test__distributed: distributed })
        const deadLetter = `${ctx.schema}_dlq`
        const queueA = `${ctx.schema}_a`
        const queueB = `${ctx.schema}_b`
        await ctx.boss.createQueue(deadLetter)
        await ctx.boss.createQueue(queueA, { deadLetter, ...sourceOptions })
        await ctx.boss.createQueue(queueB, { deadLetter })
        return { boss: ctx.boss, deadLetter, queueA, queueB }
      }

      async function deadLetterOne (boss: NonNullable<typeof ctx.boss>, source: string, data: object) {
        const id = await boss.send(source, data, { retryLimit: 0 })
        assertTruthy(id)
        await boss.fetch(source)
        await boss.fail(source, id)
      }

      async function queued (boss: NonNullable<typeof ctx.boss>, name: string) {
        const jobs = await boss.findJobs<{ n: number }>(name, { queued: true })
        return jobs.map(job => job.data.n).sort()
      }

      it(`moves the oldest matching jobs, up to the limit, back to their sources (${path})`, async function () {
        const { boss, deadLetter, queueA, queueB } = await setup()
        await deadLetterOne(boss, queueA, { n: 1, tenant: 'acme' })
        await deadLetterOne(boss, queueA, { n: 2, tenant: 'globex' })
        await deadLetterOne(boss, queueB, { n: 3, tenant: 'acme' })
        await deadLetterOne(boss, queueA, { n: 4, tenant: 'acme' })

        expect(await boss.redrive(deadLetter, { data: { tenant: 'acme' }, limit: 2 })).toBe(2)

        expect(await queued(boss, queueA)).toEqual([1])
        expect(await queued(boss, queueB)).toEqual([3])
        expect(await queued(boss, deadLetter)).toEqual([2, 4])
      })

      it(`sends every job to the destination override, including one with no source (${path})`, async function () {
        const { boss, deadLetter, queueA, queueB } = await setup()
        await deadLetterOne(boss, queueA, { n: 1 })
        await boss.send(deadLetter, { n: 2 })

        expect(await boss.redrive(deadLetter, { destination: queueB })).toBe(2)

        expect(await queued(boss, queueB)).toEqual([1, 2])
        expect(await queued(boss, queueA)).toEqual([])
        expect(await queued(boss, deadLetter)).toEqual([])
      })

      it(`moves nothing when no job matches (${path})`, async function () {
        const { boss, deadLetter, queueA } = await setup()
        expect(await boss.redrive(deadLetter)).toBe(0)

        await deadLetterOne(boss, queueA, { n: 1 })
        expect(await boss.redrive(deadLetter, { sourceName: `${ctx.schema}_b` })).toBe(0)
        expect(await queued(boss, deadLetter)).toEqual([1])
      })

      it(`fails a job whose re-insert collides in the batch, in place, with the reason (${path})`, async function () {
        const { boss, deadLetter, queueA } = await setup({ policy: 'short' })
        await deadLetterOne(boss, queueA, { n: 1 })
        await deadLetterOne(boss, queueA, { n: 2 })

        expect(await boss.redrive(deadLetter)).toBe(1)

        const kept = await queued(boss, queueA)
        expect(kept).toHaveLength(1)
        if (!helper.isCockroachDb) expect(kept).toEqual([1])

        const [left] = await boss.findJobs<{ n: number }>(deadLetter)
        assertTruthy(left)
        expect(left.data.n).toBe(helper.isCockroachDb ? 3 - kept[0] : 2)
        expect(left.state).toBe('failed')
        expect(left.sourceName).toBe(queueA)
        expect(left.output).toMatchObject({ reason: 'redrive_conflict', destination: queueA, policy: 'short', singletonKey: null })
        expect((left.output as { message: string }).message).toContain(`queue ${queueA} already has a job`)

        // Not a candidate again, so a draining loop ends.
        expect(await boss.redrive(deadLetter)).toBe(0)
      })

      it(`fails a job that collides with one already in the destination, and redrives it once retried (${path})`, async function () {
        const { boss, deadLetter, queueA } = await setup({ policy: 'short' })
        await deadLetterOne(boss, queueA, { n: 1 })
        // Holds queueA's one created slot for the singletonKey-less short policy.
        await boss.send(queueA, { n: 2 })

        expect(await boss.redrive(deadLetter)).toBe(0)

        const [left] = await boss.findJobs<{ n: number }>(deadLetter)
        assertTruthy(left)
        expect(left.state).toBe('failed')

        // Once the job it collided with has moved on, retrying puts it back in line for redrive.
        await boss.fetch(queueA)
        await boss.retry(deadLetter, left.id)
        expect((await boss.previewRedrive(deadLetter)).total).toBe(1)
        expect(await boss.redrive(deadLetter)).toBe(1)
        expect(await queued(boss, queueA)).toEqual([1])
      })

      it(`keeps the source output on the dead letter copy and not on the redriven job (${path})`, async function () {
        const { boss, deadLetter, queueA } = await setup()
        const id = await boss.send(queueA, { n: 1 }, { retryLimit: 0 })
        assertTruthy(id)
        await boss.fetch(queueA)
        await boss.fail(queueA, id, { message: 'boom' })

        const [copy] = await boss.findJobs(deadLetter)
        assertTruthy(copy)
        expect(copy.sourceOutput).toEqual({ message: 'boom' })
        expect(copy.output).toBeNull()

        expect(await boss.redrive(deadLetter)).toBe(1)
        const redriven = (await boss.findJobs(queueA, { queued: true }))[0]
        assertTruthy(redriven)
        expect(redriven.output).toBeNull()
        expect(redriven.sourceOutput).toBeNull()
      })

      it(`moves a legacy copy's output to sourceOutput when failing it on a collision (${path})`, async function () {
        const { boss, deadLetter, queueA } = await setup({ policy: 'short' })
        await deadLetterOne(boss, queueA, { n: 1 })
        await boss.send(queueA, { n: 2 })

        // A copy made before source_output existed carried the original's output as its own.
        const db = await helper.getDb()
        await db.executeSql(`UPDATE ${ctx.schema}.job SET output = '{"message":"old error"}', source_output = NULL WHERE name = $1`, [deadLetter])
        await db.close()

        expect(await boss.redrive(deadLetter)).toBe(0)

        const [left] = await boss.findJobs(deadLetter)
        assertTruthy(left)
        expect(left.sourceOutput).toEqual({ message: 'old error' })
        expect(left.output).toMatchObject({ reason: 'redrive_conflict' })
      })
    })
  }

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
