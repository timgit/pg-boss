import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import * as plans from '../src/plans.ts'
import { delay } from '../src/tools.ts'

// The test helper forces supervise:false; opt back in so the background poller actually runs.
const flowConfig = {
  supervise: true,
  flowIntervalSeconds: 1,
  __test__bypass_flow_interval_check: true
}

// Reset the cluster cadence gate so the next background poll resolves immediately.
async function triggerFlowPoll (schema: string) {
  const db = await helper.getDb()
  await db.executeSql(`UPDATE ${schema}.version SET flow_on = NULL`)
  await db.close()
}

function waitForFlowEvent (boss: any, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      boss.off('flow', handler)
      reject(new Error('Timeout waiting for flow event'))
    }, timeoutMs)

    const handler = (event: any) => {
      clearTimeout(timeout)
      boss.off('flow', handler)
      resolve(event)
    }
    boss.on('flow', handler)
  })
}

describe('navigator (flow resolver)', function () {
  // Regression guard for issue #824: completion must not touch the dependency tables.
  describe('hot path stays join-free', function () {
    it('completeJobs does no dependency work', function () {
      for (const sql of [plans.completeJobs('pgboss', 'job'), plans.completeJobs('pgboss', 'job', true)]) {
        expect(sql).not.toContain('job_dependency')
        expect(sql).not.toMatch(/FOR UPDATE/i)
      }
    })

    it('completeJobsWithOutputs does no dependency work', function () {
      const sql = plans.completeJobsWithOutputs('pgboss', 'job')
      expect(sql).not.toContain('job_dependency')
      expect(sql).not.toMatch(/FOR UPDATE/i)
    })

    it('distributed completion does not chase dependents', function () {
      expect(plans.completeJobsDistributed('pgboss', 'job')).not.toContain('blocking')
      expect(plans.completeJobsWithOutputsDistributed('pgboss', 'job')).not.toContain('blocking')
    })
  })

  it('does not unblock dependents on the hot path; resolveFlow() unblocks them', async function () {
    // supervise:false so the background poller never runs and resolution is fully manual.
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const [parent] = await ctx.boss.fetch(ctx.schema)
    expect(parent.id).toBe(flow.parent)
    await ctx.boss.complete(ctx.schema, flow.parent)

    // Completion alone must not unblock the child — that inline work was the #824 regression.
    const stillBlocked = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(stillBlocked)
    expect(stillBlocked.blocked).toBe(true)
    expect(stillBlocked.pendingDependencies).toBe(1)

    await ctx.boss.resolveFlow()

    const unblocked = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(unblocked)
    expect(unblocked.blocked).toBe(false)
    expect(unblocked.pendingDependencies).toBe(0)
  })

  it('is idempotent across repeated resolveFlow() passes', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, supervise: false })

    const flow = await ctx.boss.flow([
      { ref: 'p1', name: ctx.schema },
      { ref: 'p2', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['p1', 'p2'] }
    ])

    const parents = await ctx.boss.fetch(ctx.schema, { batchSize: 2 })
    expect(parents.length).toBe(2)
    await ctx.boss.complete(ctx.schema, parents.map(j => j.id))

    await ctx.boss.resolveFlow()
    await ctx.boss.resolveFlow()
    await ctx.boss.resolveFlow()

    const child = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(child)
    expect(child.blocked).toBe(false)
    // pending_dependencies clamps at 0 — no parent is ever decremented twice.
    expect(child.pendingDependencies).toBe(0)
  })

  it('unblocks dependents from the background poll without an explicit trigger', async function () {
    ctx.boss = await helper.start({ ...ctx.bossConfig, ...flowConfig })

    const flow = await ctx.boss.flow([
      { ref: 'parent', name: ctx.schema },
      { ref: 'child', name: ctx.schema, dependsOn: ['parent'] }
    ])

    const [parent] = await ctx.boss.fetch(ctx.schema)
    expect(parent.id).toBe(flow.parent)

    const flowEvent = waitForFlowEvent(ctx.boss)
    await ctx.boss.complete(ctx.schema, flow.parent)
    await triggerFlowPoll(ctx.schema)
    await flowEvent

    const child = await ctx.boss.getJobById(ctx.schema, flow.child)
    helper.assertTruthy(child)
    expect(child.blocked).toBe(false)
    expect(child.pendingDependencies).toBe(0)
  })

  it('emits error when the poll throws', async function () {
    const errorMessage = 'test flow poll error'
    ctx.boss = new PgBoss({
      ...ctx.bossConfig,
      ...flowConfig,
      __test__throw_flow: errorMessage
    })

    const errors: Error[] = []
    ctx.boss.on('error', (err: Error) => errors.push(err))

    await ctx.boss.start()
    await delay(1500)

    expect(errors.some(e => e.message === errorMessage)).toBe(true)
  })

  it('exposes isResolvingFlow() and serializes resolveFlow() behind an in-flight poll', async function () {
    // __test__delay_flow_ms holds each background poll's #working flag open long enough to observe.
    ctx.boss = new PgBoss({
      ...ctx.bossConfig,
      ...flowConfig,
      __test__delay_flow_ms: 300
    })

    await ctx.boss.start()

    // Catch a background poll mid-flight: exercises the #working getter, isResolvingFlow(), and the
    // __test__delay_flow_ms branch of #onPoll. Poll up to ~2s (interval is 1s) to avoid flakiness.
    let observedInFlight = false
    for (let i = 0; i < 400; i++) {
      if (ctx.boss.isResolvingFlow()) {
        observedInFlight = true
        break
      }
      await delay(5)
    }

    expect(observedInFlight).toBe(true)

    // Invoked while a poll is in flight, resolveFlow() must wait its turn (exercises resolveNow's
    // `while (#working)` guard) and then complete without hanging.
    await ctx.boss.resolveFlow()
  })
})
