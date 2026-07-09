import { describe, expect, it } from 'vitest'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'
import * as plans from '../src/plans.ts'

const describeRepro = describe.skipIf(
  helper.isCockroachDb ||
  helper.isYugabyteDb ||
  helper.isCitus ||
  helper.isPglite ||
  helper.isDistributed
)

interface PlanNode {
  'Node Type': string
  'CTE Name'?: string
  'Actual Rows'?: number
  'Actual Loops'?: number
  'Plan Rows'?: number
  Plans?: PlanNode[]
}

interface ExplainedPlan {
  plan: PlanNode
  nodes: PlanNode[]
}

const saturatedGroup = 'group-saturated'
const activeGroupCount = 115
const saturatedPendingCount = 12_000
const availablePendingCount = 36

function collectPlanNodes (node: PlanNode, nodes: PlanNode[] = []): PlanNode[] {
  nodes.push(node)

  for (const child of node.Plans ?? []) {
    collectPlanNodes(child, nodes)
  }

  return nodes
}

function extractPlan (rows: any[]): PlanNode {
  const rawPlan = rows[0]['QUERY PLAN']
  const parsed = typeof rawPlan === 'string' ? JSON.parse(rawPlan) : rawPlan
  return parsed[0].Plan
}

function planSummary (nodes: PlanNode[]): string {
  return nodes
    .filter(node => node['Node Type'] === 'Nested Loop' || node['Node Type'] === 'Hash Join' || node['Node Type'] === 'CTE Scan' || node['Node Type'] === 'Index Scan')
    .map(node => {
      const type = node['Node Type']
      const planRows = node['Plan Rows'] ?? '?'
      const actualRows = node['Actual Rows'] ?? '?'
      const actualLoops = node['Actual Loops'] ?? '?'
      return `${type}: planRows=${planRows}, actualRows=${actualRows}, actualLoops=${actualLoops}`
    })
    .join('\n')
}

function findPathologicalCteScan (nodes: PlanNode[]): PlanNode | undefined {
  return nodes.find(node =>
    node['Node Type'] === 'CTE Scan' &&
    node['CTE Name'] === 'active_group_counts' &&
    (node['Plan Rows'] ?? 0) <= 1 &&
    (node['Actual Rows'] ?? 0) >= 100 &&
    (node['Actual Loops'] ?? 0) >= saturatedPendingCount
  )
}

function expectNoPathologicalCteScan (nodes: PlanNode[]): void {
  expect(findPathologicalCteScan(nodes), planSummary(nodes)).toBeUndefined()
}

function expectClaimedJob (plan: PlanNode): void {
  expect(plan['Actual Rows']).toBe(1)
}

async function explainGroupConcurrencyFetchPlan ({
  refreshStatisticsAfterFixture,
  groupConcurrency
}: {
  refreshStatisticsAfterFixture: boolean
  groupConcurrency: number
}): Promise<ExplainedPlan> {
  // The shared hooks create a schema unique to each test and drop it after a passing run.
  // This repro owns cleanup explicitly because one case is expected to fail until the query is fixed.
  ctx.boss = await helper.start(ctx.bossConfig)

  const schema = ctx.schema
  const queueName = ctx.schema
  const db = await helper.getDb()

  try {
    // Seed one active saturated-group slot and analyze immediately. In the stale-statistics case
    // this makes Postgres believe the active-group aggregate contains a single group with one row.
    await db.executeSql(`
      INSERT INTO ${schema}.job_common (name, data, state, group_id, start_after, created_on, started_on)
      VALUES ($1, '{}'::jsonb, 'active'::${schema}.job_state, $2, now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes')
    `, [queueName, saturatedGroup])

    await db.executeSql(`ANALYZE ${schema}.job_common`)

    // Fill the rest of the saturated group's active slots after ANALYZE. For groupConcurrency: 1
    // this inserts no rows; for higher limits it keeps the group actually saturated while leaving
    // planner stats stale.
    await db.executeSql(`
      INSERT INTO ${schema}.job_common (name, data, state, group_id, start_after, created_on, started_on)
      SELECT $1, '{}'::jsonb, 'active'::${schema}.job_state, $2, now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes'
      FROM generate_series(1, $3::int)
    `, [queueName, saturatedGroup, groupConcurrency - 1])

    // Add the real active-group cardinality after the first ANALYZE. Without a later ANALYZE,
    // the fetch CTE actually returns about 100 active groups while planner stats can still
    // estimate it near one row.
    await db.executeSql(`
      INSERT INTO ${schema}.job_common (name, data, state, group_id, start_after, created_on, started_on)
      SELECT $1, '{}'::jsonb, 'active'::${schema}.job_state, 'active-group-' || g::text, now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes'
      FROM generate_series(1, $2::int) g
    `, [queueName, activeGroupCount - 1])

    // Fill the front of the queue with one saturated group. Since every groupConcurrency slot is
    // already active, these rows are runnable by state but ineligible by group.
    await db.executeSql(`
      INSERT INTO ${schema}.job_common (name, data, state, group_id, start_after, created_on)
      SELECT $1, '{}'::jsonb, 'created'::${schema}.job_state, $2, now() - interval '5 minutes', now() - interval '4 minutes' + (g * interval '1 millisecond')
      FROM generate_series(1, $3::int) g
    `, [queueName, saturatedGroup, saturatedPendingCount])

    // Add a few eligible groups behind the saturated backlog so the query has to scan past the
    // dominant group before it can claim work.
    await db.executeSql(`
      INSERT INTO ${schema}.job_common (name, data, state, group_id, start_after, created_on)
      SELECT $1, '{}'::jsonb, 'created'::${schema}.job_state, 'available-group-' || g::text, now() - interval '5 minutes', now() - interval '3 minutes' + (g * interval '1 millisecond')
      FROM generate_series(1, $2::int) g
    `, [queueName, availablePendingCount])

    if (refreshStatisticsAfterFixture) {
      // The passing control case refreshes stats after all rows exist. The stale-stats repro
      // intentionally skips this to model the planner blind spot from production.
      await db.executeSql(`ANALYZE ${schema}.job_common`)
    }

    // Use pg-boss's actual groupConcurrency fetch query. Current pg-boss fails the stale-stats
    // check because Postgres can choose a CTE-rescan plan; the fix should make both cases pass.
    const query = plans.fetchNextJob({
      schema,
      table: 'job_common',
      name: queueName,
      policy: 'standard',
      limit: 1,
      priority: false,
      orderByCreatedOn: true,
      ignoreSingletons: null,
      groupConcurrency
    })

    const explain = await db.executeSql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.values)
    const plan = extractPlan(explain.rows)
    return { plan, nodes: collectPlanNodes(plan) }
  } finally {
    await db.close()

    if (ctx.boss) {
      await ctx.boss.stop({ timeout: 2000 })
      ctx.boss = undefined
    }

    await helper.dropSchema(schema)
  }
}

describeRepro('groupConcurrency fetch plan repro', function () {
  it('does not rescan active_group_counts when table statistics are current', { timeout: 120000 }, async function () {
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: true,
      groupConcurrency: 1
    })

    expectClaimedJob(plan)
    expectNoPathologicalCteScan(nodes)
  })

  it('does not rescan active_group_counts once per saturated pending job with stale statistics', { timeout: 120000 }, async function () {
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: false,
      groupConcurrency: 1
    })

    // The pathological plan estimates active_group_counts as one row, then nested-loop scans that
    // CTE once per saturated pending row. A robust query shape should avoid this even when stats
    // are stale.
    expectClaimedJob(plan)
    expectNoPathologicalCteScan(nodes)
  })

  it('does not rescan active_group_counts when table statistics are current and groupConcurrency is greater than 1', { timeout: 120000 }, async function () {
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: true,
      groupConcurrency: 2
    })

    expectClaimedJob(plan)
    expectNoPathologicalCteScan(nodes)
  })

  it('does not rescan active_group_counts once per saturated pending job with stale statistics and groupConcurrency is greater than 1', { timeout: 120000 }, async function () {
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: false,
      groupConcurrency: 2
    })

    // The pathological plan estimates active_group_counts as one row, then nested-loop scans that
    // CTE once per saturated pending row. A robust query shape should avoid this even when stats
    // are stale.
    expectClaimedJob(plan)
    expectNoPathologicalCteScan(nodes)
  })
})
