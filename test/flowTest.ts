import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss, states } from '../src/index.ts'

describe('flows', function () {
  it('should block a job until its parent completes', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, data: { child: true }, dependsOn: ['parent'] }
    ])

    const parentId = flow.parent
    const childId = flow.child

    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    const parentJob = await ctx.boss.getJobById(ctx.schema, parentId)
    assertTruthy(parentJob)
    expect(parentJob.blocking).toBe(true)

    const fetched1 = await ctx.boss.fetch(ctx.schema)
    expect(fetched1.length).toBe(1)
    expect(fetched1[0].id).toBe(parentId)

    await ctx.boss.complete(ctx.schema, parentId)

    const fetched2 = await ctx.boss.fetch(ctx.schema)
    expect(fetched2.length).toBe(1)
    expect(fetched2[0].id).toBe(childId)
  })

  it('should support fan-in: child waits for multiple parents', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'p1', name: ctx.schema, data: { step: 1 } },
      { ref: 'p2', name: ctx.schema, data: { step: 2 } },
      { ref: 'child', name: ctx.schema, data: { step: 'aggregate' }, dependsOn: ['p1', 'p2'] }
    ])

    const parentId1 = flow.p1
    const parentId2 = flow.p2
    const childId = flow.child

    const parent1Job = await ctx.boss.getJobById(ctx.schema, parentId1)
    const parent2Job = await ctx.boss.getJobById(ctx.schema, parentId2)
    assertTruthy(parent1Job)
    assertTruthy(parent2Job)
    expect(parent1Job.blocking).toBe(true)
    expect(parent2Job.blocking).toBe(true)

    const [job1] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job1.id)

    const childAfterOne = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childAfterOne)
    expect(childAfterOne.blocked).toBe(true)

    const [job2] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job2.id)

    const childAfterAll = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childAfterAll)
    expect(childAfterAll.blocked).toBe(false)

    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(1)
    expect(fetched[0].id).toBe(childId)
  })

  it('should allow getDependencies and getDependents', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema, data: { role: 'parent' } },
      { ref: 'child', name: ctx.schema, data: { role: 'child' }, dependsOn: ['parent'] }
    ])

    const parentId = flow.parent
    const childId = flow.child

    const deps = await ctx.boss.getDependencies(ctx.schema, childId)
    expect(deps.length).toBe(1)
    expect(deps[0].name).toBe(ctx.schema)
    expect(deps[0].id).toBe(parentId)

    const dependents = await ctx.boss.getDependents(ctx.schema, parentId)
    expect(dependents.length).toBe(1)
    expect(dependents[0].name).toBe(ctx.schema)
    expect(dependents[0].id).toBe(childId)
  })

  it('should keep child blocked when parent fails permanently', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema, options: { retryLimit: 0 } },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const parentId = flow.parent
    const childId = flow.child

    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job.id).toBe(parentId)
    await ctx.boss.fail(ctx.schema, parentId, new Error('permanent failure'))

    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(0)
  })

  it('should keep child blocked when parent is cancelled', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const parentId = flow.parent
    const childId = flow.child

    await ctx.boss.cancel(ctx.schema, parentId)

    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(0)
  })

  it('should support cross-queue dependencies', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queue1 = ctx.schema + '-q1'
    const queue2 = ctx.schema + '-q2'

    await ctx.boss.createQueue(queue1)
    await ctx.boss.createQueue(queue2)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: queue1, data: { role: 'parent' } },
      { ref: 'child', name: queue2, data: { role: 'child' }, dependsOn: ['parent'] }
    ])

    const parentId = flow.parent
    const childId = flow.child

    const fetched1 = await ctx.boss.fetch(queue2)
    expect(fetched1.length).toBe(0)

    const [job] = await ctx.boss.fetch(queue1)
    expect(job.id).toBe(parentId)
    await ctx.boss.complete(queue1, parentId)

    const fetched2 = await ctx.boss.fetch(queue2)
    expect(fetched2.length).toBe(1)
    expect(fetched2[0].id).toBe(childId)
  })

  it('should reject invalid flow input', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'a', name: ctx.schema }
      ])
    }).rejects.toThrow('flow requires at least 2 jobs')

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'a', name: ctx.schema },
        { ref: 'a', name: ctx.schema }
      ])
    }).rejects.toThrow('duplicate ref')

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'a', name: ctx.schema },
        { ref: 'b', name: ctx.schema, dependsOn: ['missing'] }
      ])
    }).rejects.toThrow('not found in flow')

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'a', name: ctx.schema },
        { ref: 'b', name: ctx.schema }
      ])
    }).rejects.toThrow('flow requires at least one job with dependsOn')

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'x', name: ctx.schema },
        { ref: 'z', name: ctx.schema },
        { ref: 'y', name: ctx.schema, dependsOn: ['x', 'z'] },
        { ref: 'a', name: ctx.schema, dependsOn: ['b'] },
        { ref: 'b', name: ctx.schema, dependsOn: ['a'] }
      ])
    }).rejects.toThrow('flow contains a dependency cycle: a -> b -> a')
  })

  it('should validate flow job options like send()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'parent', name: ctx.schema },
        { ref: 'child', name: ctx.schema, options: { priority: 1.5 }, dependsOn: ['parent'] }
      ])
    }).rejects.toThrow('priority must be an integer')

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'parent', name: ctx.schema, options: { retryLimit: -1 } },
        { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
      ])
    }).rejects.toThrow('retryLimit must be an integer >= 0')

    // nothing should have been inserted when validation fails
    const fetched = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(fetched.length).toBe(0)
  })

  it('should support flow with a provided db', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const db = await helper.getDb()
    const calls: string[] = []

    try {
      const flow = await ctx.boss.flow([
        { ref: 'parent', name: ctx.schema },
        { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
      ], {
        db: {
          async executeSql (sql, values) {
            calls.push(sql)
            return db.executeSql(sql, values)
          }
        }
      })

      const childJob = await ctx.boss.getJobById(ctx.schema, flow.child)
      assertTruthy(childJob)
      expect(childJob.blocked).toBe(true)
      expect(calls.length).toBeGreaterThan(0)
    } finally {
      await db.close()
    }
  })

  it('should support flow with a constructor-provided db', async function () {
    const db = await helper.getDb()
    const calls: string[] = []

    try {
      ctx.boss = new PgBoss({
        ...ctx.bossConfig,
        db: {
          async executeSql (sql, values) {
            calls.push(sql)
            return db.executeSql(sql, values)
          }
        }
      })

      await ctx.boss.start()
      await ctx.boss.createQueue(ctx.schema)

      const flow = await ctx.boss.flow([
        { ref: 'parent', name: ctx.schema },
        { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
      ])

      const childJob = await ctx.boss.getJobById(ctx.schema, flow.child)
      assertTruthy(childJob)
      expect(childJob.blocked).toBe(true)
      expect(calls.length).toBeGreaterThan(0)
    } finally {
      await ctx.boss?.stop({ close: false })
      await db.close()
    }
  })

  it('should roll back flow when job creation fails', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'parent', name: ctx.schema, options: { id: 'not-a-uuid' } },
        { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
      ])
    }).rejects.toThrow('invalid input syntax for type uuid')

    const fetched = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(fetched.length).toBe(0)
  })

  it('should honor startAfter on a dependent job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, options: { startAfter: 3600 }, dependsOn: ['parent'] }
    ])

    const childId = flow.child

    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(false)

    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(0)
  })

  it('should complete batch including dependency unblock', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'p1', name: ctx.schema, data: { p: 1 } },
      { ref: 'p2', name: ctx.schema, data: { p: 2 } },
      { ref: 'c1', name: ctx.schema, data: { c: 1 }, dependsOn: ['p1'] },
      { ref: 'c2', name: ctx.schema, data: { c: 2 }, dependsOn: ['p2'] }
    ])

    const parents = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(parents.length).toBe(2)

    await ctx.boss.complete(ctx.schema, parents.map(j => j.id))

    const children = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(children.length).toBe(2)
    const childIds = children.map(j => j.id).sort()
    expect(childIds).toEqual([flow.c1, flow.c2].sort())
  })

  it('should unblock fan-in child when sibling parents complete concurrently', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db1 = await helper.getDb()
    const db2 = await helper.getDb()

    try {
      const flow = await ctx.boss.flow([
        { ref: 'p1', name: ctx.schema },
        { ref: 'p2', name: ctx.schema },
        { ref: 'child', name: ctx.schema, dependsOn: ['p1', 'p2'] }
      ])

      const parents = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
      expect(parents.length).toBe(2)

      await Promise.all([
        ctx.boss.complete(ctx.schema, flow.p1, null, { db: db1 }),
        ctx.boss.complete(ctx.schema, flow.p2, null, { db: db2 })
      ])

      const childJob = await ctx.boss.getJobById(ctx.schema, flow.child)
      assertTruthy(childJob)
      expect(childJob.blocked).toBe(false)
      expect(childJob.pendingDependencies).toBe(0)

      const fetched = await ctx.boss.fetch(ctx.schema)
      expect(fetched.length).toBe(1)
      expect(fetched[0].id).toBe(flow.child)
    } finally {
      await db1.close()
      await db2.close()
    }
  })

  it('should roll back flow when an insert conflict skips a job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const id = randomUUID()

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'parent', name: ctx.schema, options: { id } },
        { ref: 'child', name: ctx.schema, options: { id }, dependsOn: ['parent'] }
      ])
    }).rejects.toThrow('one or more jobs could not be created')

    const jobCount = await helper.countJobs(ctx.schema, 'job', 'name = $1', [ctx.schema])
    const dependencyCount = await helper.countJobs(ctx.schema, 'job_dependency', 'true')
    expect(jobCount).toBe(0)
    expect(dependencyCount).toBe(0)
  })

  it('should raise a helpful error when a queue policy dedupes flow jobs', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { policy: 'short' })

    await expect(async () => {
      await ctx.boss!.flow([
        { ref: 'parent', name: ctx.schema },
        { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
      ])
    }).rejects.toThrow('one or more jobs could not be created')

    const jobCount = await helper.countJobs(ctx.schema, 'job', 'name = $1', [ctx.schema])
    expect(jobCount).toBe(0)
  })

  it('should support two complete calls in one transaction', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)
    const db = await helper.getDb()

    try {
      const flow = await ctx.boss.flow([
        { ref: 'parent', name: ctx.schema },
        { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
      ])

      const [parent] = await ctx.boss.fetch(ctx.schema)
      expect(parent.id).toBe(flow.parent)

      await db.withTransaction(async txDb => {
        const parentResult = await ctx.boss!.complete(ctx.schema, flow.parent, null, { db: txDb })
        expect(parentResult.affected).toBe(1)

        const childResult = await ctx.boss!.complete(ctx.schema, flow.child, null, { db: txDb, includeQueued: true })
        expect(childResult.affected).toBe(1)
      })

      const childJob = await ctx.boss.getJobById(ctx.schema, flow.child)
      assertTruthy(childJob)
      expect(childJob.blocked).toBe(false)
      expect(childJob.pendingDependencies).toBe(0)
      expect(childJob.state).toBe(states.completed)
    } finally {
      await db.close()
    }
  })

  it('should complete a blocked child with its parent when includeQueued is true', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const result = await ctx.boss.complete(ctx.schema, [flow.parent, flow.child], null, { includeQueued: true })
    expect(result.affected).toBe(2)

    const parentJob = await ctx.boss.getJobById(ctx.schema, flow.parent)
    const childJob = await ctx.boss.getJobById(ctx.schema, flow.child)
    assertTruthy(parentJob)
    assertTruthy(childJob)
    expect(parentJob.state).toBe(states.completed)
    expect(childJob.state).toBe(states.completed)
    expect(childJob.blocked).toBe(false)
    expect(childJob.pendingDependencies).toBe(0)
  })

  it('should block and unblock a job on a partitioned queue', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    await ctx.boss.createQueue(ctx.schema, { partition: true })

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, data: { child: true }, dependsOn: ['parent'] }
    ])

    const parentId = flow.parent
    const childId = flow.child

    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    const parentJob = await ctx.boss.getJobById(ctx.schema, parentId)
    assertTruthy(parentJob)
    expect(parentJob.blocking).toBe(true)

    const fetched1 = await ctx.boss.fetch(ctx.schema)
    expect(fetched1.length).toBe(1)
    expect(fetched1[0].id).toBe(parentId)

    await ctx.boss.complete(ctx.schema, parentId)

    const childAfter = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childAfter)
    expect(childAfter.blocked).toBe(false)
    expect(childAfter.pendingDependencies).toBe(0)

    const fetched2 = await ctx.boss.fetch(ctx.schema)
    expect(fetched2.length).toBe(1)
    expect(fetched2[0].id).toBe(childId)
  })
})
