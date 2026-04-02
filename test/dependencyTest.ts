import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { PgBoss } from '../src/index.ts'

describe('dependencies', function () {
  it('should block a job until its parent completes', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.createFlow([
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

    const flow = await ctx.boss.createFlow([
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

    const flow = await ctx.boss.createFlow([
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

    const flow = await ctx.boss.createFlow([
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

    const flow = await ctx.boss.createFlow([
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

    const flow = await ctx.boss.createFlow([
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

  it('should reject invalid createFlow input', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.createFlow([
        { ref: 'a', name: ctx.schema }
      ])
    }).rejects.toThrow('createFlow requires at least 2 jobs')

    await expect(async () => {
      await ctx.boss!.createFlow([
        { ref: 'a', name: ctx.schema },
        { ref: 'a', name: ctx.schema }
      ])
    }).rejects.toThrow('duplicate ref')

    await expect(async () => {
      await ctx.boss!.createFlow([
        { ref: 'a', name: ctx.schema },
        { ref: 'b', name: ctx.schema, dependsOn: ['missing'] }
      ])
    }).rejects.toThrow('not found in flow')

    await expect(async () => {
      await ctx.boss!.createFlow([
        { ref: 'a', name: ctx.schema },
        { ref: 'b', name: ctx.schema }
      ])
    }).rejects.toThrow('createFlow requires at least one job with dependsOn')

    await expect(async () => {
      await ctx.boss!.createFlow([
        { ref: 'x', name: ctx.schema },
        { ref: 'z', name: ctx.schema },
        { ref: 'y', name: ctx.schema, dependsOn: ['x', 'z'] },
        { ref: 'a', name: ctx.schema, dependsOn: ['b'] },
        { ref: 'b', name: ctx.schema, dependsOn: ['a'] }
      ])
    }).rejects.toThrow('createFlow contains a dependency cycle: a -> b -> a')
  })

  it('should support createFlow with a provided db', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const db = await helper.getDb()
    const calls: string[] = []

    try {
      const flow = await ctx.boss.createFlow([
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

  it('should support createFlow with a constructor-provided db', async function () {
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

      const flow = await ctx.boss.createFlow([
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

  it('should roll back createFlow when job creation fails', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.createFlow([
        { ref: 'parent', name: ctx.schema, options: { id: 'not-a-uuid' } },
        { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
      ])
    }).rejects.toThrow('invalid input syntax for type uuid')

    const fetched = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(fetched.length).toBe(0)
  })

  it('should honor startAfter on a dependent job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const flow = await ctx.boss.createFlow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, options: { startAfter: 3600 }, dependsOn: ['parent'] }
    ])

    const parentId = flow.parent
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

    const flow = await ctx.boss.createFlow([
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
})
