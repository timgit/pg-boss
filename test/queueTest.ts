import { expect, vi } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { PgBoss, states } from '../src/index.ts'
import * as plans from '../src/plans.ts'
import { ctx } from './hooks.ts'

describe('queues', function () {
  it('deleteQueue on a missing queue is a no-op', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    // getQueueCache throws for a non-existent queue; that lookup failure is the only thing swallowed
    await expect(ctx.boss.deleteQueue(`${ctx.schema}_missing`)).resolves.toBeUndefined()
  })

  it('loads a queue another instance created on its first use', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const other = await helper.start({ ...ctx.bossConfig, noDefault: true })

    try {
      // Created after this instance loaded its queue cache, so the send below misses it.
      await other.createQueue(ctx.schema)

      const jobId = await ctx.boss.send(ctx.schema)
      assertTruthy(jobId)
      expect((await ctx.boss.getJobById(ctx.schema, jobId))?.id).toBe(jobId)
    } finally {
      await other.stop({ graceful: false })
    }
  })

  it('drops a cached queue that updateQueue finds deleted by another instance', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const other = await helper.start({ ...ctx.bossConfig, noDefault: true })

    try {
      await ctx.boss.createQueue(ctx.schema)
      await other.deleteQueue(ctx.schema)

      // The update matches no row, and the stale cache entry goes with it rather than being used.
      await ctx.boss.updateQueue(ctx.schema, { retryLimit: 5 })

      await expect(ctx.boss.send(ctx.schema)).rejects.toThrow(`Queue ${ctx.schema} does not exist`)
    } finally {
      await other.stop({ graceful: false })
    }
  })

  /** A cached queue deleted elsewhere: the insert used to find no queue row and read as a refusal. */
  // With partition: true the queue's own table is dropped with it, so the insert fails on the table.
  describe.each([false, true])('writing to a queue another instance deleted (partition: %s)', function (partition) {
    async function deletedElsewhere (...names: string[]) {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      const other = await helper.start({ ...ctx.bossConfig, noDefault: true })
      try {
        await ctx.boss.createQueue(ctx.schema, { partition })
        for (const name of names) await ctx.boss.createQueue(name)
        await other.deleteQueue(ctx.schema)
      } finally {
        await other.stop({ graceful: false })
      }
      return ctx.boss
    }

    it('send throws rather than resolving null', async function () {
      const boss = await deletedElsewhere()
      await expect(boss.send(ctx.schema)).rejects.toThrow(`Queue ${ctx.schema} does not exist`)
      // The stale entry is gone, so the next call fails up front as for any missing queue.
      await expect(boss.send(ctx.schema)).rejects.toThrow(`Queue ${ctx.schema} does not exist`)
    })

    it('a throttled send throws rather than resolving null', async function () {
      const boss = await deletedElsewhere()
      await expect(boss.send(ctx.schema, null, { singletonSeconds: 300, singletonNextSlot: true })).rejects.toThrow(`Queue ${ctx.schema} does not exist`)
    })

    it('insert throws rather than resolving null, with or without returnId', async function () {
      const boss = await deletedElsewhere()
      await expect(boss.insert(ctx.schema, [{ data: { a: 1 } }], { returnId: true })).rejects.toThrow(`Queue ${ctx.schema} does not exist`)
      await expect(boss.insert(ctx.schema, [{ data: { a: 1 } }])).rejects.toThrow(`Queue ${ctx.schema} does not exist`)
    })

    it('upsert throws rather than reporting nothing done', async function () {
      const boss = await deletedElsewhere()
      await expect(boss.upsert(ctx.schema, { a: 1 }, { singletonKey: 'k' })).rejects.toThrow(`Queue ${ctx.schema} does not exist`)
    })

    it('flow names the deleted queue and creates none of its jobs', async function () {
      const kept = `${ctx.schema}_kept`
      const boss = await deletedElsewhere(kept)

      await expect(boss.flow([
        { ref: 'a', name: kept },
        { ref: 'b', name: ctx.schema, dependsOn: ['a'] }
      ])).rejects.toThrow(`Queue ${ctx.schema} does not exist`)

      expect(await boss.fetch(kept)).toHaveLength(0)
    })

    it('send names a dead letter queue that does not exist', async function () {
      const deadLetter = `${ctx.schema}_dlq`
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      await ctx.boss.createQueue(ctx.schema)
      await ctx.boss.createQueue(deadLetter)
      await ctx.boss.deleteQueue(deadLetter)

      await expect(ctx.boss.send(ctx.schema, null, { deadLetter })).rejects.toThrow(`Dead letter queue ${deadLetter} does not exist`)
    })

    // With the partitioned layout q_fkey is deferred, so a caller's transaction hears of it at its own
    // COMMIT; where it is not deferred (CockroachDB, YugabyteDB) send() rejects.
    helper.itPglite('a caller transaction hears of it at send or at its COMMIT', async function () {
      const boss = await deletedElsewhere()
      const db = await helper.getDb()
      const client = await (db as any).pool.connect()
      let error: any

      try {
        await client.query('BEGIN')
        try {
          await boss.send(ctx.schema, null, { db: { executeSql: (sql: string, values: any[]) => client.query(sql, values) } })
          await client.query('COMMIT')
        } catch (err) {
          error = err
          await client.query('ROLLBACK')
        }
      } finally {
        client.release()
        await db.close()
      }

      // 23503 from q_fkey, or 42P01 from the dropped table of a queue with its own.
      expect(['23503', '42P01']).toContain((error?.cause ?? error)?.code)
    })
  })

  // Partitioning is off on CockroachDB and YugabyteDB, so a queue never gets a table of its own there.
  // The old table is gone (42P01), or is the shared table, whose partition constraint now excludes the queue (23514).
  it.skipIf(helper.isCockroachDb || helper.isYugabyteDb).each([
    { from: true, code: '42P01' },
    { from: false, code: '23514' }
  ])('takes the new table of a queue another instance deleted and created again (was partition: $from)', async function ({ from, code }) {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const other = await helper.start({ ...ctx.bossConfig, noDefault: true })

    try {
      await ctx.boss.createQueue(ctx.schema, { partition: from })
      await other.deleteQueue(ctx.schema)
      await other.createQueue(ctx.schema, { partition: !from })
    } finally {
      await other.stop({ graceful: false })
    }

    // The queue exists, so the failure is not rewritten, but the cache is reloaded.
    await expect(ctx.boss.send(ctx.schema)).rejects.toMatchObject({ code })
    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)
    expect((await ctx.boss.getJobById(ctx.schema, jobId))?.id).toBe(jobId)
  })

  it('a send a throttle refuses still resolves null', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema)

    expect(await ctx.boss.send(ctx.schema, null, { singletonSeconds: 300 })).toBeTruthy()
    expect(await ctx.boss.send(ctx.schema, null, { singletonSeconds: 300 })).toBeNull()
  })

  it('deleteQueue surfaces a DELETE failure instead of resolving as success', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    // warm the manager's queue cache so the mocked failure lands on the DELETE, not the cache lookup
    await ctx.boss.fetch(ctx.schema)

    const db = ctx.boss.getDb()
    const spy = vi.spyOn(db, 'executeSql').mockRejectedValueOnce(new Error('delete boom'))

    await expect(ctx.boss.deleteQueue(ctx.schema)).rejects.toThrow('delete boom')

    spy.mockRestore()
  })
  // Without table partitioning a queue never has its own table to drop. The YugabyteDB profile turns
  // partitioning off and otherwise runs on Postgres, which is how this reaches that path here.
  it.skipIf(helper.isPglite || helper.isCockroachDb)('deleteQueue removes a queue and its jobs without table partitioning', async function () {
    ctx.boss = new PgBoss({ ...ctx.bossConfig, backend: 'yugabytedb' })
    await ctx.boss.start()
    await ctx.boss.createQueue(ctx.schema)
    const id = await ctx.boss.send(ctx.schema)
    assertTruthy(id)

    await ctx.boss.deleteQueue(ctx.schema)

    expect(await ctx.boss.getQueue(ctx.schema)).toBeNull()
    expect(await helper.countJobs(ctx.schema, 'job', 'id = $1', [id])).toBe(0)
  })

  // A queue with its own table is dropped after taking its locks with NOWAIT, tried again while they
  // are busy. PGlite has one connection to hold a lock with, and these backends have no partitions.
  describe.skipIf(helper.isPglite || helper.isCockroachDb || helper.isYugabyteDb)('deleteQueue with partition: true', function () {
    async function holdLock (sql: string) {
      const db = await helper.getDb()
      const tx = await db.beginTransaction()
      await tx.db.executeSql(sql)
      return async () => {
        await tx.commit()
        await db.close()
      }
    }

    async function run (sql: string) {
      const db = await helper.getDb()
      try {
        return (await db.executeSql(sql)).rows
      } finally {
        await db.close()
      }
    }

    const tableExists = async (table: string) => (await run(`SELECT to_regclass('${ctx.schema}.${table}') IS NOT NULL as "exists"`))[0].exists

    async function partitioned () {
      ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
      await ctx.boss.createQueue(ctx.schema, { partition: true })
      const queue = await ctx.boss.getQueue(ctx.schema)
      assertTruthy(queue)
      return queue.table
    }

    it('waits out a send holding job_common instead of deadlocking with it', async function () {
      const table = await partitioned()
      // What an insert into a shared queue holds while it runs.
      const release = await holdLock(`LOCK TABLE ${ctx.schema}.job_common IN ROW EXCLUSIVE MODE`)

      let settled = false
      const deleting = ctx.boss!.deleteQueue(ctx.schema).finally(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(settled).toBe(false)
      expect(await ctx.boss!.getQueue(ctx.schema)).toBeTruthy()

      await release()
      await deleting

      expect(await ctx.boss!.getQueue(ctx.schema)).toBeNull()
      expect(await tableExists(table)).toBe(false)
    })

    it('gives up when its tables stay locked, and leaves the queue in place', async function () {
      const table = await partitioned()
      const release = await holdLock(`LOCK TABLE ${ctx.schema}.job_common IN ROW EXCLUSIVE MODE`)

      try {
        await expect(ctx.boss!.deleteQueue(ctx.schema)).rejects.toThrow(`Queue ${ctx.schema} was not deleted: its tables stayed locked through 12 tries`)
        expect(await ctx.boss!.getQueue(ctx.schema)).toBeTruthy()
        expect(await tableExists(table)).toBe(true)
      } finally {
        await release()
      }

      await ctx.boss!.deleteQueue(ctx.schema)
      expect(await ctx.boss!.getQueue(ctx.schema)).toBeNull()
    })

    it('a send to a deleted queue keeps its own error when the queue cannot be read again', async function () {
      await partitioned()
      await ctx.boss!.fetch(ctx.schema)
      const other = await helper.start({ ...ctx.bossConfig, noDefault: true })

      try {
        await other.deleteQueue(ctx.schema)

        // The send fails on the dropped table, and the read that would tell a gone queue from a recreated
        // one fails too, so the original error is what the caller gets.
        const db = ctx.boss!.getDb()
        const executeSql = db.executeSql.bind(db)
        const reread = plans.getQueues(ctx.schema, [ctx.schema]).text
        const spy = vi.spyOn(db, 'executeSql').mockImplementation((sql: string, values?: unknown[]) =>
          sql === reread ? Promise.reject(new Error('read boom')) : executeSql(sql, values))

        try {
          await expect(ctx.boss!.send(ctx.schema)).rejects.toThrow(/relation .* does not exist/)
        } finally {
          spy.mockRestore()
        }
      } finally {
        await other.stop({ graceful: false })
      }
    })

    it('does nothing for a queue another instance already deleted', async function () {
      await partitioned()
      await ctx.boss!.fetch(ctx.schema)
      const other = await helper.start({ ...ctx.bossConfig, noDefault: true })

      try {
        await other.deleteQueue(ctx.schema)
        await expect(ctx.boss!.deleteQueue(ctx.schema)).resolves.toBeUndefined()
      } finally {
        await other.stop({ graceful: false })
      }
    })
  })

  it('should create a queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
  })

  it('should not add a policy property when creating a queue if it is missing', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const options = {}

    await ctx.boss.createQueue(ctx.schema, options)

    expect(Object.keys(options).length).toBe(0)
  })

  it('createQueue should work if queue already exists', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.createQueue(ctx.schema)
  })

  it('should reject a queue with invalid characters', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = `*${ctx.bossConfig.schema}`
    await expect(async () => {
      await ctx.boss!.createQueue(queue)
    }).rejects.toThrow()
  })

  it('should reject a queue with invalid policy', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.createQueue(ctx.schema, { policy: 'something' })
    }).rejects.toThrow()
  })

  it('should reject using a queue if not created', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await expect(async () => {
      await ctx.boss!.send(ctx.schema)
    }).rejects.toThrow()
  })

  it('should create a queue with standard policy', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'standard' })
  })

  it('should delete and then create a queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    expect(await ctx.boss.getQueue(ctx.schema)).toBeTruthy()
    await ctx.boss.deleteQueue(ctx.schema)
    await ctx.boss.createQueue(ctx.schema)
  })

  helper.itPostgresOnly('should not use a stale cached table after delete and recreate with a different partition setting', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queue = ctx.schema

    await ctx.boss.createQueue(queue, { partition: true })
    await ctx.boss.send(queue)

    await ctx.boss.deleteQueue(queue)
    await ctx.boss.createQueue(queue, { partition: false })

    const jobId = await ctx.boss.send(queue)

    assertTruthy(jobId)
    const jobs = await ctx.boss.findJobs(queue, { id: jobId })
    const job = jobs[0]
    expect(job).toBeTruthy()
    expect(job!.id).toBe(jobId)
  })

  it('should delete an empty queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.deleteAllJobs(ctx.schema)
    await ctx.boss.deleteQueue(ctx.schema)
  })

  helper.itPostgresOnly('should truncate a partitioned queue and leave other queues alone', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queue2 = `${ctx.schema}2`
    await ctx.boss.createQueue(queue2)
    await ctx.boss.send(queue2)

    await ctx.boss.createQueue(ctx.schema, { partition: true })
    await ctx.boss.send(ctx.schema)

    await ctx.boss.deleteAllJobs(ctx.schema)
    await ctx.boss.deleteQueue(ctx.schema)

    const [{ queuedCount }] = await ctx.boss.getQueueStats(queue2)
    expect(queuedCount).toBeTruthy()
  })

  helper.itPostgresOnly('should truncate a partitioned queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { partition: true })
    await ctx.boss.send(ctx.schema)
    // A truncate reports no count, and pg-boss does not count to find one.
    expect(await ctx.boss.deleteAllJobs(ctx.schema)).toBeNull()
    await ctx.boss.deleteQueue(ctx.schema)
  })

  it('should say how many jobs a delete removed', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.send(ctx.schema)

    expect(await ctx.boss.deleteAllJobs(ctx.schema)).toBe(2)
    expect(await ctx.boss.deleteAllJobs(ctx.schema)).toBe(0)
  })

  helper.itPostgresOnly('should delete all jobs from all queues, included partitioned', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { partition: true })
    await ctx.boss.send(ctx.schema)

    const queue2 = `${ctx.schema}2`
    await ctx.boss.createQueue(queue2)
    await ctx.boss.send(queue2)

    await ctx.boss.deleteAllJobs()

    const [{ queuedCount: count1 }] = await ctx.boss.getQueueStats(ctx.schema)
    const [{ queuedCount: count2 }] = await ctx.boss.getQueueStats(queue2)

    expect(count1 + count2).toBe(0)
  })

  it('should delete a non-empty queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema)
    await ctx.boss.send(ctx.schema)
    await ctx.boss.deleteQueue(ctx.schema)
  })

  it('should delete all queued jobs from a queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const getCount = () => helper.countJobs(ctx.bossConfig.schema, 'job', 'state = $1', [states.created])

    await ctx.boss.send(ctx.schema)

    expect(await getCount()).toBe(1)

    expect(await ctx.boss.deleteQueuedJobs(ctx.schema)).toBe(1)

    expect(await getCount()).toBe(0)
  })

  it('should delete all stored jobs from a queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const { completed, failed, cancelled } = states
    const inClause = [completed, failed, cancelled].map(s => `'${s}'`)
    const getCount = () => helper.countJobs(ctx.bossConfig.schema, 'job', `state IN (${inClause})`)

    await ctx.boss.send(ctx.schema)
    const [job1] = await ctx.boss.fetch(ctx.schema)
    expect(job1?.id).toBeTruthy()

    await ctx.boss.complete(ctx.schema, job1.id)

    expect(await getCount()).toBe(1)

    await ctx.boss.send(ctx.schema, null, { retryLimit: 0 })
    const [job2] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, job2.id)

    expect(await getCount()).toBe(2)

    expect(await ctx.boss.deleteStoredJobs(ctx.schema)).toBe(2)

    expect(await getCount()).toBe(0)
  })

  it('getQueue() returns null when missing', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue = await ctx.boss.getQueue(ctx.bossConfig.schema)
    expect(queue).toBe(null)
  })

  it('getQueues() returns queues array', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue1 = `${ctx.bossConfig.schema}_1`
    const queue2 = `${ctx.bossConfig.schema}_2`

    await ctx.boss.createQueue(queue1)
    await ctx.boss.createQueue(queue2)

    const queues = await ctx.boss.getQueues()

    expect(queues.length).toBe(2)

    expect(queues.some(q => q.name === queue1)).toBeTruthy()
    expect(queues.some(q => q.name === queue2)).toBeTruthy()
  })

  it('getQueues(names) filters to the requested queues', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const queue1 = `${ctx.bossConfig.schema}_1`
    const queue2 = `${ctx.bossConfig.schema}_2`
    const queue3 = `${ctx.bossConfig.schema}_3`

    await ctx.boss.createQueue(queue1)
    await ctx.boss.createQueue(queue2)
    await ctx.boss.createQueue(queue3)

    const queues = await ctx.boss.getQueues([queue1, queue2])

    expect(queues.length).toBe(2)
    expect(queues.some(q => q.name === queue1)).toBeTruthy()
    expect(queues.some(q => q.name === queue2)).toBeTruthy()
    expect(queues.some(q => q.name === queue3)).toBeFalsy()
  })

  it('should update queue properties', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    let deadLetter = `${ctx.schema}_dlq1`
    await ctx.boss.createQueue(deadLetter)

    const createProps = {
      policy: 'standard',
      retryLimit: 1,
      retryBackoff: true,
      retryDelayMax: 3,
      retryDelay: 1,
      expireInSeconds: 1,
      retentionSeconds: 1,
      deadLetter
    }

    await ctx.boss.createQueue(ctx.schema, createProps)

    let queueObj = await ctx.boss.getQueue(ctx.schema)

    expect(queueObj).toBeTruthy()

    expect(queueObj!.name).toBe(ctx.schema)
    expect(queueObj!.policy).toBe(createProps.policy)
    expect(queueObj!.retryLimit).toBe(createProps.retryLimit)
    expect(queueObj!.retryBackoff).toBe(createProps.retryBackoff)
    expect(queueObj!.retryDelay).toBe(createProps.retryDelay)
    expect(queueObj!.retryDelayMax).toBe(createProps.retryDelayMax)
    expect(queueObj!.expireInSeconds).toBe(createProps.expireInSeconds)
    expect(queueObj!.retentionSeconds).toBe(createProps.retentionSeconds)
    expect(queueObj!.deadLetter).toBe(createProps.deadLetter)
    expect(queueObj!.createdOn).toBeTruthy()
    expect(queueObj!.updatedOn).toBeTruthy()

    deadLetter = `${ctx.schema}_dlq2`
    await ctx.boss.createQueue(deadLetter)

    const updateProps = {
      retryDelay: 2,
      retryLimit: 2,
      retryBackoff: false,
      expireInSeconds: 2,
      deadLetter
    }

    await ctx.boss.updateQueue(ctx.schema, updateProps)

    queueObj = await ctx.boss.getQueue(ctx.schema)

    expect(queueObj!.retryLimit).toBe(updateProps.retryLimit)
    expect(queueObj!.retryBackoff).toBe(updateProps.retryBackoff)
    expect(queueObj!.retryDelay).toBe(updateProps.retryDelay)
    expect(queueObj!.expireInSeconds).toBe(updateProps.expireInSeconds)
    expect(queueObj!.deadLetter).toBe(updateProps.deadLetter)
  })

  it('should clear the dead letter queue with null', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    expect((await ctx.boss.getQueue(ctx.schema))!.deadLetter).toBe(deadLetter)

    await ctx.boss.updateQueue(ctx.schema, { deadLetter: null })

    expect((await ctx.boss.getQueue(ctx.schema))!.deadLetter).toBeNull()
  })

  it('should not clear the dead letter queue when other properties are updated', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter })

    await ctx.boss.updateQueue(ctx.schema, { retryLimit: 5 })

    const queueObj = await ctx.boss.getQueue(ctx.schema)

    expect(queueObj!.retryLimit).toBe(5)
    expect(queueObj!.deadLetter).toBe(deadLetter)
  })

  it('should route failed jobs to the queue itself after the dead letter queue is cleared', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)
    await ctx.boss.createQueue(ctx.schema, { deadLetter, retryLimit: 0 })

    await ctx.boss.updateQueue(ctx.schema, { deadLetter: null })

    const jobId = await ctx.boss.send(ctx.schema)
    assertTruthy(jobId)

    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.fail(ctx.schema, job.id)

    expect((await ctx.boss.fetch(deadLetter)).length).toBe(0)
  })

  it('should clear the nullable numeric options with null', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { retryBackoff: true, retryDelayMax: 60, heartbeatSeconds: 30 })

    await ctx.boss.updateQueue(ctx.schema, { retryDelayMax: null, heartbeatSeconds: null })

    const queueObj = await ctx.boss.getQueue(ctx.schema)

    expect(queueObj!.retryDelayMax).toBeNull()
    expect(queueObj!.heartbeatSeconds).toBeNull()
  })

  it('should fail to change queue policy', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'standard' })

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.updateQueue(ctx.schema, { policy: 'exclusive' })
    }).rejects.toThrow()
  })

  helper.itPostgresOnly('should fail to change queue partitioning', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.createQueue(ctx.schema, { partition: true })

    await expect(async () => {
      // @ts-ignore
      await ctx.boss.updateQueue(ctx.schema, { partition: false })
    }).rejects.toThrow()
  })

  it('jobs should inherit properties from queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const deadLetter = `${ctx.schema}_dlq`
    await ctx.boss.createQueue(deadLetter)

    const createProps = {
      retryLimit: 1,
      retryBackoff: true,
      retryDelay: 2,
      retryDelayMax: 3,
      expireInSeconds: 4,
      retentionSeconds: 4,
      deadLetter
    }

    await ctx.boss.createQueue(ctx.schema, createProps)

    const jobId = await ctx.boss.send(ctx.schema)

    assertTruthy(jobId)
    const job = await ctx.boss.getJobById(ctx.schema, jobId)

    assertTruthy(job)

    const retentionSeconds = (new Date(job.keepUntil).getTime() - new Date(job.createdOn).getTime()) / 1000

    expect(job.retryLimit).toBe(createProps.retryLimit)
    expect(job.retryBackoff).toBe(createProps.retryBackoff)
    expect(job.retryDelay).toBe(createProps.retryDelay)
    expect(job.retryDelayMax).toBe(createProps.retryDelayMax)
    expect(job.deadLetter).toBe(createProps.deadLetter)
    expect(job.expireInSeconds).toBe(createProps.expireInSeconds)
    expect(retentionSeconds).toBe(createProps.retentionSeconds)
  })
})
