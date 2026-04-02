import { expect } from 'vitest'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { ctx } from './hooks.ts'
import { states } from '../src/index.ts'

describe('dependencies', function () {
  it('should block a job until its parent completes', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parentId = await ctx.boss.send(ctx.schema)
    assertTruthy(parentId)

    const childId = await ctx.boss.send(ctx.schema, { child: true }, {
      dependsOn: [{ name: ctx.schema, id: parentId }]
    })
    assertTruthy(childId)

    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    const parentJob = await ctx.boss.getJobById(ctx.schema, parentId)
    assertTruthy(parentJob)
    expect(parentJob.blocking).toBe(true)

    // child should not be fetchable while parent is pending
    const fetched1 = await ctx.boss.fetch(ctx.schema)
    expect(fetched1.length).toBe(1)
    expect(fetched1[0].id).toBe(parentId)

    // complete the parent
    await ctx.boss.complete(ctx.schema, parentId)

    // now the child should be fetchable
    const fetched2 = await ctx.boss.fetch(ctx.schema)
    expect(fetched2.length).toBe(1)
    expect(fetched2[0].id).toBe(childId)
  })

  it('should support fan-in: child waits for multiple parents', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parentId1 = await ctx.boss.send(ctx.schema, { step: 1 })
    const parentId2 = await ctx.boss.send(ctx.schema, { step: 2 })
    assertTruthy(parentId1)
    assertTruthy(parentId2)

    const childId = await ctx.boss.send(ctx.schema, { step: 'aggregate' }, {
      dependsOn: [
        { name: ctx.schema, id: parentId1 },
        { name: ctx.schema, id: parentId2 }
      ]
    })
    assertTruthy(childId)

    const parent1Job = await ctx.boss.getJobById(ctx.schema, parentId1)
    const parent2Job = await ctx.boss.getJobById(ctx.schema, parentId2)
    assertTruthy(parent1Job)
    assertTruthy(parent2Job)
    expect(parent1Job.blocking).toBe(true)
    expect(parent2Job.blocking).toBe(true)

    // fetch and complete only the first parent
    const [job1] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job1.id)

    // child should still be blocked
    const childAfterOne = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childAfterOne)
    expect(childAfterOne.blocked).toBe(true)

    // fetch and complete the second parent
    const [job2] = await ctx.boss.fetch(ctx.schema)
    expect(job2.id).toBe(parentId2)
    await ctx.boss.complete(ctx.schema, job2.id)

    // now child should be unblocked
    const childAfterAll = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childAfterAll)
    expect(childAfterAll.blocked).toBe(false)

    // child should be fetchable now
    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(1)
    expect(fetched[0].id).toBe(childId)
  })

  it('should allow getDependencies and getDependents', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parentId = await ctx.boss.send(ctx.schema, { role: 'parent' })
    assertTruthy(parentId)

    const childId = await ctx.boss.send(ctx.schema, { role: 'child' }, {
      dependsOn: [{ name: ctx.schema, id: parentId }]
    })
    assertTruthy(childId)

    const deps = await ctx.boss.getDependencies(ctx.schema, childId)
    expect(deps.length).toBe(1)
    expect(deps[0].name).toBe(ctx.schema)
    expect(deps[0].id).toBe(parentId)

    const dependents = await ctx.boss.getDependents(ctx.schema, parentId)
    expect(dependents.length).toBe(1)
    expect(dependents[0].name).toBe(ctx.schema)
    expect(dependents[0].id).toBe(childId)
  })

  it('should support dependencies via insert()', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const [parentId] = (await ctx.boss.insert(ctx.schema, [
      { data: { step: 'extract' } }
    ], { returnId: true }))!
    assertTruthy(parentId)

    const [childId] = (await ctx.boss.insert(ctx.schema, [
      { data: { step: 'load' }, dependsOn: [{ name: ctx.schema, id: parentId }] }
    ], { returnId: true }))!
    assertTruthy(childId)

    // child should be blocked
    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    // fetch should only return the parent
    const fetched = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(fetched.length).toBe(1)
    expect(fetched[0].id).toBe(parentId)

    // complete parent
    await ctx.boss.complete(ctx.schema, parentId)

    // now child is fetchable
    const fetched2 = await ctx.boss.fetch(ctx.schema)
    expect(fetched2.length).toBe(1)
    expect(fetched2[0].id).toBe(childId)
  })

  it('should keep child blocked when parent fails permanently', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parentId = await ctx.boss.send(ctx.schema, {}, { retryLimit: 0 })
    assertTruthy(parentId)

    const childId = await ctx.boss.send(ctx.schema, {}, {
      dependsOn: [{ name: ctx.schema, id: parentId }]
    })
    assertTruthy(childId)

    // fetch and fail the parent
    const [job] = await ctx.boss.fetch(ctx.schema)
    expect(job.id).toBe(parentId)
    await ctx.boss.fail(ctx.schema, parentId, new Error('permanent failure'))

    // child should still be blocked
    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    // no jobs should be fetchable
    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(0)
  })

  it('should keep child blocked when parent is cancelled', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parentId = await ctx.boss.send(ctx.schema)
    assertTruthy(parentId)

    const childId = await ctx.boss.send(ctx.schema, {}, {
      dependsOn: [{ name: ctx.schema, id: parentId }]
    })
    assertTruthy(childId)

    await ctx.boss.cancel(ctx.schema, parentId)

    // child should still be blocked
    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    // no jobs should be fetchable
    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(0)
  })

  it('should support cross-queue dependencies', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })

    const queue1 = ctx.schema + '-q1'
    const queue2 = ctx.schema + '-q2'

    await ctx.boss.createQueue(queue1)
    await ctx.boss.createQueue(queue2)

    const parentId = await ctx.boss.send(queue1, { role: 'parent' })
    assertTruthy(parentId)

    const childId = await ctx.boss.send(queue2, { role: 'child' }, {
      dependsOn: [{ name: queue1, id: parentId }]
    })
    assertTruthy(childId)

    // child should not be fetchable
    const fetched1 = await ctx.boss.fetch(queue2)
    expect(fetched1.length).toBe(0)

    // complete the parent in queue1
    const [job] = await ctx.boss.fetch(queue1)
    expect(job.id).toBe(parentId)
    await ctx.boss.complete(queue1, parentId)

    // now the child in queue2 should be fetchable
    const fetched2 = await ctx.boss.fetch(queue2)
    expect(fetched2.length).toBe(1)
    expect(fetched2[0].id).toBe(childId)
  })

  it('should reject invalid dependsOn', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    await expect(async () => {
      await ctx.boss!.send(ctx.schema, {}, {
        // @ts-ignore
        dependsOn: 'not-an-array'
      })
    }).rejects.toThrow('dependsOn must be an array')

    await expect(async () => {
      await ctx.boss!.send(ctx.schema, {}, {
        dependsOn: []
      })
    }).rejects.toThrow('dependsOn must not be empty')

    await expect(async () => {
      await ctx.boss!.send(ctx.schema, {}, {
        // @ts-ignore
        dependsOn: [{ name: 'queue' }]
      })
    }).rejects.toThrow('dependency id must be a non-empty string')
  })

  it('should honor startAfter on a dependent job', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parentId = await ctx.boss.send(ctx.schema)
    assertTruthy(parentId)

    const childId = await ctx.boss.send(ctx.schema, {}, {
      startAfter: 3600,
      dependsOn: [{ name: ctx.schema, id: parentId }]
    })
    assertTruthy(childId)

    // complete the parent
    const [job] = await ctx.boss.fetch(ctx.schema)
    await ctx.boss.complete(ctx.schema, job.id)

    // child is unblocked but start_after is in the future
    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(false)

    // child should still not be fetchable (start_after is 1h from now)
    const fetched = await ctx.boss.fetch(ctx.schema)
    expect(fetched.length).toBe(0)
  })

  it('should support dependencies with debounced jobs', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parentId = await ctx.boss.send(ctx.schema)
    assertTruthy(parentId)

    // first send fills the current throttle slot
    await ctx.boss.send(ctx.schema, { attempt: 1 }, {
      singletonSeconds: 60,
      singletonKey: 'debounce-dep-test'
    })

    // second send with singletonNextSlot triggers the debounce path
    const childId = await ctx.boss.send(ctx.schema, { attempt: 2 }, {
      singletonSeconds: 60,
      singletonNextSlot: true,
      singletonKey: 'debounce-dep-test',
      dependsOn: [{ name: ctx.schema, id: parentId }]
    })
    assertTruthy(childId)

    const childJob = await ctx.boss.getJobById(ctx.schema, childId)
    assertTruthy(childJob)
    expect(childJob.blocked).toBe(true)

    const deps = await ctx.boss.getDependencies(ctx.schema, childId)
    expect(deps.length).toBe(1)
    expect(deps[0].id).toBe(parentId)
  })

  it('should complete batch including dependency unblock', async function () {
    ctx.boss = await helper.start(ctx.bossConfig)

    const parent1 = await ctx.boss.send(ctx.schema, { p: 1 })
    const parent2 = await ctx.boss.send(ctx.schema, { p: 2 })
    assertTruthy(parent1)
    assertTruthy(parent2)

    const child1 = await ctx.boss.send(ctx.schema, { c: 1 }, {
      dependsOn: [{ name: ctx.schema, id: parent1 }]
    })
    const child2 = await ctx.boss.send(ctx.schema, { c: 2 }, {
      dependsOn: [{ name: ctx.schema, id: parent2 }]
    })
    assertTruthy(child1)
    assertTruthy(child2)

    // fetch both parents
    const parents = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(parents.length).toBe(2)

    // complete both in one batch
    await ctx.boss.complete(ctx.schema, parents.map(j => j.id))

    // both children should now be fetchable
    const children = await ctx.boss.fetch(ctx.schema, { batchSize: 10 })
    expect(children.length).toBe(2)
    const childIds = children.map(j => j.id).sort()
    expect(childIds).toEqual([child1, child2].sort())
  })
})
