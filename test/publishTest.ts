import { expect, vi } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as plans from '../src/plans.ts'

describe('pubsub', function () {
  it('should fail with no arguments', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await expect(async () => {
      // @ts-ignore
      await ctx.boss.publish()
    }).rejects.toThrow()
  })

  it('should accept single string argument', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.publish(ctx.schema)
  })

  it('should not send to the same named queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const message = 'hi'

    await ctx.boss.publish(ctx.schema, { message })

    const [job] = await ctx.boss.fetch(ctx.schema)

    expect(job).toBeFalsy()
  })

  it('should use subscriptions to map to a single queue', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const event = 'event'
    const message = 'hi'

    await ctx.boss.subscribe(event, ctx.schema)
    await ctx.boss.publish(event, { message })

    const [job] = await ctx.boss.fetch<{ message: string }>(ctx.schema)

    expect(job.data.message).toBe(message)
  })

  it('should use subscriptions to map to more than one queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    interface Message {
      message: string
    }

    const queue1 = 'subqueue1'
    const queue2 = 'subqueue2'

    await ctx.boss.createQueue(queue1)
    await ctx.boss.createQueue(queue2)

    const event = 'event'
    const message = 'hi'

    await ctx.boss.subscribe(event, queue1)
    await ctx.boss.subscribe(event, queue2)
    await ctx.boss.publish(event, { message })

    const [job1] = await ctx.boss.fetch<Message>(queue1)
    const [job2] = await ctx.boss.fetch<Message>(queue2)

    expect(job1.data.message).toBe(message)
    expect(job2.data.message).toBe(message)
  })

  it.each([
    { cache: 'cold', fail: false, partition: false },
    { cache: 'warm', fail: false, partition: false },
    { cache: 'warm', fail: false, partition: true },
    { cache: 'cold', fail: true, partition: false }
  ])('should handle subscriber removal (cache: $cache, other failure: $fail, partition: $partition)', async function ({ cache, fail, partition }) {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.stop({ close: false })
    const publisher = await helper.start({ ...ctx.bossConfig, migrate: false, noDefault: true })

    try {
      await publisher.stop({ close: false })

      const departing = 'subqueue-departing'
      const healthy = 'subqueue-healthy'
      const failing = 'subqueue-failing'
      const event = 'event'
      const data = { message: 'hi' }

      await ctx.boss.createQueue(departing, { partition })
      await ctx.boss.createQueue(healthy)
      await ctx.boss.subscribe(event, departing)
      await ctx.boss.subscribe(event, healthy)
      const queue = await ctx.boss.getQueue(departing)
      assertTruthy(queue)

      if (fail) {
        await ctx.boss.createQueue(failing, { policy: 'key_strict_fifo' })
        await ctx.boss.subscribe(event, failing)
        await publisher.fetch(failing)
      }

      // Only the departing subscriber needs a metadata lookup in the cold case.
      await publisher.fetch(healthy)
      if (cache === 'warm') await publisher.fetch(departing)

      const db = publisher.getDb()
      const executeSql = db.executeSql.bind(db)
      const statement = cache === 'cold'
        ? plans.getQueues(ctx.schema, [departing]).text
        : plans.insertJobs(ctx.schema, { table: queue.table, name: departing })
      const { reached, release } = helper.holdStatement(db, sql => sql === statement)
      const publication = publisher.publish(event, data).then(
        () => undefined,
        (error: unknown) => error
      )

      try {
        // Both boundaries follow subscription selection, before the departing send uses SQL. The healthy
        // send lands first: dropping a queue's own table while an insert into job_common is in flight
        // can deadlock the two, which is not what this test is about.
        await reached
        await helper.until(async () => (await ctx.boss.findJobs(healthy)).length > 0)
        await ctx.boss.unsubscribe(event, departing)
        await ctx.boss.deleteQueue(departing)
        expect(await ctx.boss.getQueue(departing)).toBeNull()
        release()

        const error = await publication
        expect((await ctx.boss.findJobs(healthy)).map(job => job.data)).toEqual([data])
        if (fail) {
          expect(error).toBeInstanceOf(AggregateError)
          expect(error).toMatchObject({
            message: "publish('event') failed for 1 of 3 subscribed queue(s)",
            errors: [expect.stringMatching(/^subqueue-failing: .*key_strict_fifo/)]
          })
          expect(await ctx.boss.findJobs(failing)).toEqual([])
        } else {
          expect(error).toBeUndefined()
        }
      } finally {
        release()
        await publication
        db.executeSql = executeSql
      }
    } finally {
      await publisher.stop()
    }
  })

  it('should resolve when every selected subscriber disappears', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const boss = ctx.boss
    await boss.stop({ close: false })
    const publisher = await helper.start({ ...ctx.bossConfig, migrate: false, noDefault: true })

    try {
      await publisher.stop({ close: false })
      const names = ['subqueue1', 'subqueue2']
      for (const name of names) {
        await boss.createQueue(name)
        await boss.subscribe('event', name)
      }

      const db = publisher.getDb()
      const executeSql = db.executeSql.bind(db)
      const statement = plans.getQueuesForEvent(ctx.schema)
      const spy = vi.spyOn(db, 'executeSql').mockImplementation(async (sql, values) => {
        const result = await executeSql(sql, values)
        if (sql === statement) {
          // Keep the real selection, but remove its destinations before returning it.
          expect(result.rows.map(row => row.name).sort()).toEqual(names)
          for (const name of names) {
            await boss.unsubscribe('event', name)
            await boss.deleteQueue(name)
          }
        }
        return result
      })

      try {
        await publisher.publish('event', { message: 'hi' })
        expect(spy).toHaveBeenCalledWith(statement, ['event'])
        for (const name of names) expect(await boss.getQueue(name)).toBeNull()
        expect(await helper.countJobs(ctx.schema, 'job', '1 = 1')).toBe(0)
      } finally {
        spy.mockRestore()
      }
    } finally {
      await publisher.stop()
    }
  })

  it('should ignore a subscriber removed before publication', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue('departing')
    await ctx.boss.createQueue('healthy')
    await ctx.boss.subscribe('event', 'departing')
    await ctx.boss.subscribe('event', 'healthy')
    await ctx.boss.unsubscribe('event', 'departing')
    await ctx.boss.deleteQueue('departing')

    const data = { message: 'hi' }
    await ctx.boss.publish('event', data)

    expect(await ctx.boss.getQueue('departing')).toBeNull()
    expect((await ctx.boss.findJobs('healthy')).map(job => job.data)).toEqual([data])
  })

  it('should still reject a direct send to a missing queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await expect(ctx.boss.send('missing')).rejects.toMatchObject({
      name: 'Error',
      message: 'Queue missing does not exist'
    })
  })

  it.each(['matching message', 'database error'])('should preserve a %s during metadata lookup', async function (failure) {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    await ctx.boss.stop({ close: false })
    const publisher = await helper.start({ ...ctx.bossConfig, migrate: false, noDefault: true })

    try {
      await publisher.stop({ close: false })

      const healthy = 'subqueue-healthy'
      const failing = 'subqueue-failing'
      const data = { message: 'hi' }

      await ctx.boss.createQueue(healthy)
      await ctx.boss.createQueue(failing)
      await ctx.boss.subscribe('event', healthy)
      await ctx.boss.subscribe('event', failing)
      await publisher.fetch(healthy)
      const db = publisher.getDb()
      const executeSql = db.executeSql.bind(db)
      const statement = plans.getQueues(ctx.schema, [failing]).text
      const message = failure === 'matching message'
        ? `Queue ${failing} does not exist`
        : 'division by zero'
      const spy = vi.spyOn(db, 'executeSql').mockImplementation(async (sql, values) => {
        if (sql === statement) {
          if (failure === 'matching message') throw new Error(message)
          // The metadata error comes from PostgreSQL, not a missing queue result.
          await executeSql('SELECT 1 / 0')
        }
        return await executeSql(sql, values)
      })

      try {
        await expect(publisher.publish('event', data)).rejects.toMatchObject({
          message: "publish('event') failed for 1 of 2 subscribed queue(s)",
          errors: [`${failing}: ${message}`]
        })
      } finally {
        spy.mockRestore()
      }

      expect(await ctx.boss.getQueue(failing)).toBeTruthy()
      expect(await ctx.boss.findJobs(failing)).toEqual([])
      expect((await ctx.boss.findJobs(healthy)).map(job => job.data)).toEqual([data])
    } finally {
      await publisher.stop()
    }
  })

  // The send ran on the caller's connection, where a failed statement may have aborted their transaction.
  it('should report a deleted subscriber when publishing with a db', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
    const other = await helper.start({ ...ctx.bossConfig, noDefault: true })

    try {
      await ctx.boss.createQueue(ctx.schema)
      await ctx.boss.subscribe('event', ctx.schema)

      // The subscription goes with the queue, so the deletion lands after publish() selected it.
      const db = ctx.boss.getDb()
      const caller = {
        async executeSql (sql: string, values?: unknown[]) {
          await other.deleteQueue(ctx.schema)
          return db.executeSql(sql, values)
        }
      }

      await expect(ctx.boss.publish('event', {}, { db: caller })).rejects.toMatchObject({
        errors: [`${ctx.schema}: Queue ${ctx.schema} does not exist`]
      })
    } finally {
      await other.stop({ graceful: false })
    }
  })

  it('should preserve foreign-key failures from PostgreSQL', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.subscribe('event', ctx.schema)

    await expect(ctx.boss.publish('event', { message: 'hi' }, { deadLetter: 'missing' })).rejects.toMatchObject({
      message: "publish('event') failed for 1 of 1 subscribed queue(s)",
      errors: [expect.stringMatching(/Dead letter queue missing does not exist/)]
    })
    expect(await ctx.boss.findJobs(ctx.schema)).toEqual([])
  })

  // This ordering needs separate connections and a deferred queue foreign key.
  it.skipIf(helper.isPglite || helper.isCockroachDb || helper.isYugabyteDb)('should leave a deferred queue failure to the caller-owned transaction', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.subscribe('event', ctx.schema)

    const db = await helper.getDb()
    try {
      const transaction = await db.beginTransaction()
      try {
        await ctx.boss.publish('event', { message: 'hi' }, { db: transaction.db })
        await ctx.boss.unsubscribe('event', ctx.schema)
        await ctx.boss.deleteQueue(ctx.schema)

        await expect(transaction.commit()).rejects.toMatchObject({ code: '23503', constraint: 'q_fkey' })
      } finally {
        await transaction.rollback()
      }
    } finally {
      await db.close()
    }
  })

  it('should publish through an adapter without transaction support', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    await ctx.boss.subscribe('event', ctx.schema)

    const db = ctx.boss.getDb()
    const publisher = await helper.start({
      ...ctx.bossConfig,
      db: { executeSql: db.executeSql.bind(db) },
      migrate: false,
      noDefault: true
    })

    try {
      expect(publisher.getDb().beginTransaction).toBeUndefined()
      const data = { message: 'hi' }
      await publisher.publish('event', data)
      expect((await ctx.boss.findJobs(ctx.schema)).map(job => job.data)).toEqual([data])
    } finally {
      await publisher.stop()
    }
  })

  it('should reject when a subscribed queue fails, after sending to the rest', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    interface Message {
      message: string
    }

    const healthy = 'subqueue-healthy'
    // key_strict_fifo rejects a send with no singletonKey, so publish() has one subscriber that
    // fails and one that succeeds without needing an unhealthy connection to arrange it.
    const failing = 'subqueue-failing'

    await ctx.boss.createQueue(healthy)
    await ctx.boss.createQueue(failing, { policy: 'key_strict_fifo' })

    const event = 'event'
    const message = 'hi'

    await ctx.boss.subscribe(event, healthy)
    await ctx.boss.subscribe(event, failing)

    const error = await ctx.boss.publish(event, { message }).then(
      () => undefined,
      (err: unknown) => err as AggregateError
    )

    expect(error).toBeInstanceOf(AggregateError)
    assertTruthy(error)

    expect(error.message).toMatch(/failed for 1 of 2 subscribed queue\(s\)/)

    // each entry names its own queue, so attribution doesn't rely on errors[] lining up with the
    // queue order positionally
    expect(error.errors).toHaveLength(1)
    expect(error.errors[0]).toMatch(new RegExp(`^${failing}: .*key_strict_fifo`))

    // the healthy subscriber was still sent to
    const [job1] = await ctx.boss.fetch<Message>(healthy)
    expect(job1.data.message).toBe(message)

    const [job2] = await ctx.boss.fetch(failing)
    expect(job2).toBeFalsy()
  })
})

it('should fail if unsubscribe is called without args', async function () {
  ctx.boss = await helper.start(ctx.bossConfig)
  await expect(async () => {
    // @ts-ignore
    await ctx.boss.unsubscribe()
  }).rejects.toThrow()
})

it('should fail if unsubscribe is called without both args', async function () {
  ctx.boss = await helper.start(ctx.bossConfig)
  await expect(async () => {
    // @ts-ignore
    await ctx.boss.unsubscribe('foo')
  }).rejects.toThrow()
})

it('unsubscribe works', async function () {
  ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

  const event = 'foo'

  const queue1 = 'queue1'
  const queue2 = 'queue2'

  await ctx.boss.createQueue(queue1)
  await ctx.boss.createQueue(queue2)

  await ctx.boss.subscribe(event, queue1)
  await ctx.boss.subscribe(event, queue2)

  await ctx.boss.publish(event)

  const [job1] = await ctx.boss.fetch(queue1)

  expect(job1).toBeTruthy()

  const [job2] = await ctx.boss.fetch(queue2)

  expect(job2).toBeTruthy()

  await ctx.boss.unsubscribe(event, queue2)

  await ctx.boss.publish(event)

  const [job3] = await ctx.boss.fetch(queue1)

  expect(job3).toBeTruthy()

  const [job4] = await ctx.boss.fetch(queue2)

  expect(job4).toBeFalsy()

  await ctx.boss.unsubscribe(event, queue1)

  await ctx.boss.publish(event)

  const [job5] = await ctx.boss.fetch(queue1)
  expect(job5).toBeFalsy()
})
