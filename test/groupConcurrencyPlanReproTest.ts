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
  'Index Name'?: string
  'Plan Rows'?: number
  'Relation Name'?: string
  'Subplan Name'?: string
  Plans?: PlanNode[]
}

interface ExplainedPlan {
  plan: PlanNode
  nodes: PlanNode[]
}

const saturatedGroup = 'group-saturated'
const activeGroupCount = 115
const saturatedPendingCount = 12_000
const minimumAvailablePendingCount = 36

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
    .filter(node =>
      node['Node Type'] === 'Aggregate' ||
      node['Node Type'] === 'CTE Scan' ||
      node['Node Type'] === 'Hash Join' ||
      node['Node Type'] === 'Index Only Scan' ||
      node['Node Type'] === 'Index Scan' ||
      node['Node Type'] === 'Nested Loop' ||
      node['Node Type'] === 'Subquery Scan' ||
      node['Node Type'] === 'WindowAgg'
    )
    .map(node => {
      const type = node['Node Type']
      const planRows = node['Plan Rows'] ?? '?'
      const actualRows = node['Actual Rows'] ?? '?'
      const actualLoops = node['Actual Loops'] ?? '?'
      const subplan = node['Subplan Name'] ? `, subplan=${node['Subplan Name']}` : ''
      const cte = node['CTE Name'] ? `, cte=${node['CTE Name']}` : ''
      const index = node['Index Name'] ? `, index=${node['Index Name']}` : ''
      return `${type}${subplan}${cte}${index}: planRows=${planRows}, actualRows=${actualRows}, actualLoops=${actualLoops}`
    })
    .join('\n')
}

function findRepeatedActiveGroupScan (nodes: PlanNode[]): PlanNode | undefined {
  return nodes.find(node =>
    node['Node Type'] === 'CTE Scan' &&
    node['CTE Name']?.startsWith('active_group_') === true &&
    (node['Actual Loops'] ?? 0) > 1
  )
}

function expectNoRepeatedActiveGroupScan (nodes: PlanNode[]): void {
  expect(findRepeatedActiveGroupScan(nodes), planSummary(nodes)).toBeUndefined()
}

function findRepeatedGroupRanking (nodes: PlanNode[]): PlanNode | undefined {
  return nodes.find(node =>
    node['Node Type'] === 'WindowAgg' &&
    (node['Actual Loops'] ?? 0) > 1
  )
}

function expectNoRepeatedGroupRanking (nodes: PlanNode[]): void {
  expect(findRepeatedGroupRanking(nodes), planSummary(nodes)).toBeUndefined()
}

function findRepeatedJobTableScan (nodes: PlanNode[]): PlanNode | undefined {
  return nodes.find(node =>
    node['Relation Name'] === 'job_common' &&
    (
      node['Node Type'] === 'Index Only Scan' ||
      node['Node Type'] === 'Index Scan' ||
      node['Node Type'] === 'Seq Scan'
    ) &&
    (node['Actual Loops'] ?? 0) >= saturatedPendingCount
  )
}

function expectNoRepeatedJobTableScan (nodes: PlanNode[]): void {
  expect(findRepeatedJobTableScan(nodes), planSummary(nodes)).toBeUndefined()
}

function expectClaimedJobs (plan: PlanNode, expected: number): void {
  expect(plan['Actual Rows']).toBe(expected)
}

async function explainGroupConcurrencyFetchPlan ({
  refreshStatisticsAfterFixture,
  groupConcurrency,
  batchSize = 1
}: {
  refreshStatisticsAfterFixture: boolean
  groupConcurrency: number
  batchSize?: number
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

    // Add enough eligible groups behind the saturated backlog to fill the requested batch. This
    // makes the large-batch case exercise both the hot-path filter and the post-LIMIT ranking work.
    const availablePendingCount = Math.max(minimumAvailablePendingCount, batchSize)
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
      limit: batchSize,
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

    expectClaimedJobs(plan, 1)
    expectNoRepeatedActiveGroupScan(nodes)
    expectNoRepeatedGroupRanking(nodes)
  })

  it('does not rescan active_group_counts once per saturated pending job with stale statistics', { timeout: 120000 }, async function () {
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: false,
      groupConcurrency: 1
    })

    // The pathological plan estimates active_group_counts as one row, then nested-loop scans that
    // CTE once per saturated pending row. A robust query shape should avoid this even when stats
    // are stale.
    expectClaimedJobs(plan, 1)
    expectNoRepeatedActiveGroupScan(nodes)
    expectNoRepeatedGroupRanking(nodes)
  })

  it('does not rescan active_group_counts when table statistics are current and groupConcurrency is greater than 1', { timeout: 120000 }, async function () {
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: true,
      groupConcurrency: 2
    })

    expectClaimedJobs(plan, 1)
    expectNoRepeatedActiveGroupScan(nodes)
    expectNoRepeatedGroupRanking(nodes)
    expectNoRepeatedJobTableScan(nodes)
  })

  it('does not rescan active_group_counts once per saturated pending job with stale statistics and groupConcurrency is greater than 1', { timeout: 120000 }, async function () {
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: false,
      groupConcurrency: 2
    })

    // The pathological plan estimates active_group_counts as one row, then nested-loop scans that
    // CTE once per saturated pending row. A robust query shape should avoid this even when stats
    // are stale.
    expectClaimedJobs(plan, 1)
    expectNoRepeatedActiveGroupScan(nodes)
    expectNoRepeatedGroupRanking(nodes)
    expectNoRepeatedJobTableScan(nodes)
  })

  it('does not rescan active counts or group ranking for a large batch with stale statistics', { timeout: 120000 }, async function () {
    const batchSize = 100
    const { plan, nodes } = await explainGroupConcurrencyFetchPlan({
      refreshStatisticsAfterFixture: false,
      groupConcurrency: 2,
      batchSize
    })

    expectClaimedJobs(plan, batchSize)
    expectNoRepeatedActiveGroupScan(nodes)
    expectNoRepeatedGroupRanking(nodes)
    expectNoRepeatedJobTableScan(nodes)
  })

  it('keeps the tiered fetch query shape independent of configured tier count', function () {
    const buildQuery = (tiers: Record<string, number>) => plans.fetchNextJob({
      schema: ctx.schema,
      table: 'job_common',
      name: ctx.schema,
      policy: 'standard',
      limit: 1,
      priority: false,
      orderByCreatedOn: true,
      ignoreSingletons: null,
      groupConcurrency: { default: 1, tiers }
    })

    const oneTier = buildQuery({ tier0: 2 })
    const manyTiers = buildQuery(Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`tier${index}`, 2])
    ))

    expect(manyTiers.text).toBe(oneTier.text)
  })
})
