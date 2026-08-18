import { describe, it, expect } from './harness.ts'
import * as plans from '../src/plans.ts'
import fs from 'node:fs'

// Byte-identity guard for the postgres dialect: every SQL-producing plans builder is rendered
// with fixed inputs and compared against the committed snapshot, so the dialect-seam refactor
// (and any future change) cannot alter postgres output without the diff being reviewed.
// Update deliberately with: UPDATE_SNAPSHOTS=true bun test ./test/plansSnapshot.test.ts

const S = 'pgboss'
const T = 'job'
const QUEUES = ['q1', 'q2']

const fetchBase = {
  schema: S,
  table: T,
  name: 'q1',
  policy: 'standard' as string | undefined,
  limit: 1,
  ignoreSingletons: null
}

const cases: Record<string, () => unknown> = {
  'create default': () => plans.create(S, 1),
  'create with schema': () => plans.create(S, 1, { createSchema: true }),
  'create all flags': () => plans.create(S, 1, { createSchema: true, noTablePartitioning: true, noDeferrableConstraints: true, noAdvisoryLocks: true, noCoveringIndexes: true }),
  createTableJobDependency: () => plans.createTableJobDependency(S),
  createIndexJobDependencyParent: () => plans.createIndexJobDependencyParent(S),
  jobTableFormatFunction: () => plans.jobTableFormatFunction(S),
  createQueue: () => plans.createQueue(S, 'q1', { policy: 'standard', retryLimit: 2 }),
  'createQueue noAdvisoryLocks': () => plans.createQueue(S, 'q1', { policy: 'standard', retryLimit: 2 }, true),
  notifyChannelSql: () => plans.notifyChannelSql(S),
  notifyQueue: () => plans.notifyQueue(S, 'q1'),
  deleteQueue: () => plans.deleteQueue(S, 'q1'),
  'deleteQueue noAdvisoryLocks': () => plans.deleteQueue(S, 'q1', true),
  trySetQueueMonitorTime: () => plans.trySetQueueMonitorTime(S, QUEUES, 60),
  trySetQueueDeletionTime: () => plans.trySetQueueDeletionTime(S, QUEUES, 60),
  trySetCronTime: () => plans.trySetCronTime(S, 60),
  trySetFlowTime: () => plans.trySetFlowTime(S, 60),
  updateQueue: () => plans.updateQueue(S),
  getQueues: () => plans.getQueues(S),
  'getQueues by names': () => plans.getQueues(S, QUEUES),
  deleteJobsById: () => plans.deleteJobsById(S, T),
  deleteQueuedJobs: () => plans.deleteQueuedJobs(S, T),
  deleteStoredJobs: () => plans.deleteStoredJobs(S, T),
  truncateTable: () => plans.truncateTable(S, T),
  deleteAllJobs: () => plans.deleteAllJobs(S, T),
  getSchedules: () => plans.getSchedules(S),
  getSchedulesByQueue: () => plans.getSchedulesByQueue(S),
  getSchedulesByQueueAndKey: () => plans.getSchedulesByQueueAndKey(S),
  schedule: () => plans.schedule(S),
  unschedule: () => plans.unschedule(S),
  getTime: () => plans.getTime(S),
  getQueueStatsCache: () => plans.getQueueStatsCache(S),
  getVersion: () => plans.getVersion(S),
  setVersion: () => plans.setVersion(S, 1),
  versionTableExists: () => plans.versionTableExists(S),
  getSchemaCaseVariants: () => plans.getSchemaCaseVariants(S),
  getPartitionedQueueTables: () => plans.getPartitionedQueueTables(S),
  insertVersion: () => plans.insertVersion(S, 1),
  'fetchNextJob base': () => plans.fetchNextJob({ ...fetchBase }),
  'fetchNextJob noSkipLocked': () => plans.fetchNextJob({ ...fetchBase }, true),
  'fetchNextJob metadata': () => plans.fetchNextJob({ ...fetchBase, includeMetadata: true }),
  'fetchNextJob singleton batch': () => plans.fetchNextJob({ ...fetchBase, policy: 'singleton', limit: 5 }),
  'fetchNextJob stately batch': () => plans.fetchNextJob({ ...fetchBase, policy: 'stately', limit: 5 }),
  'fetchNextJob exclusive': () => plans.fetchNextJob({ ...fetchBase, policy: 'exclusive' }),
  'fetchNextJob no priority no order ignoreStartAfter': () => plans.fetchNextJob({ ...fetchBase, priority: false, orderByCreatedOn: false, ignoreStartAfter: true }),
  'fetchNextJob ignoreSingletons': () => plans.fetchNextJob({ ...fetchBase, ignoreSingletons: ['a', 'b'] }),
  'fetchNextJob ignoreGroups': () => plans.fetchNextJob({ ...fetchBase, ignoreGroups: ['g1'] }),
  'fetchNextJob groupConcurrency single': () => plans.fetchNextJob({ ...fetchBase, groupConcurrency: 1 }),
  'fetchNextJob groupConcurrency tiers': () => plans.fetchNextJob({ ...fetchBase, groupConcurrency: { default: 2, tiers: { gold: 5 } } }),
  'fetchNextJob priority bounds': () => plans.fetchNextJob({ ...fetchBase, minPriority: 1, maxPriority: 9 }),
  'fetchNextJob kitchen sink': () => plans.fetchNextJob({ ...fetchBase, includeMetadata: true, ignoreSingletons: ['a'], ignoreGroups: ['g1'], groupConcurrency: { default: 2, tiers: { gold: 5 } }, minPriority: 1, maxPriority: 9 }),
  'fetchNextJob kitchen sink noSkipLocked': () => plans.fetchNextJob({ ...fetchBase, includeMetadata: true, ignoreSingletons: ['a'], ignoreGroups: ['g1'], groupConcurrency: { default: 2, tiers: { gold: 5 } }, minPriority: 1, maxPriority: 9 }, true),
  completeJobs: () => plans.completeJobs(S, T),
  'completeJobs includeQueued': () => plans.completeJobs(S, T, true),
  completeJobsWithOutputs: () => plans.completeJobsWithOutputs(S, T),
  completeJobsWithOutputsNoCte: () => plans.completeJobsWithOutputsNoCte(S, T),
  completeJobsNoCte: () => plans.completeJobsNoCte(S, T),
  'completeJobsNoCte includeQueued': () => plans.completeJobsNoCte(S, T, true),
  cancelJobs: () => plans.cancelJobs(S, T),
  resumeJobs: () => plans.resumeJobs(S, T),
  insertJobs: () => plans.insertJobs(S, { table: T, name: 'q1' }),
  'insertJobs no returnId': () => plans.insertJobs(S, { table: T, name: 'q1', returnId: false }),
  'insertJobs notify': () => plans.insertJobs(S, { table: T, name: 'q1', notify: true }),
  insertFlowJobs: () => plans.insertFlowJobs(S, { table: T, name: 'q1' }, [{ id: 'a' }, { id: 'b' }]),
  failJobsById: () => plans.failJobsById(S, T),
  failJobsByTimeout: () => plans.failJobsByTimeout(S, T, QUEUES),
  'failJobsByTimeout noAdvisoryLocks': () => plans.failJobsByTimeout(S, T, QUEUES, true),
  failJobsByHeartbeat: () => plans.failJobsByHeartbeat(S, T, QUEUES),
  'failJobsByHeartbeat noAdvisoryLocks': () => plans.failJobsByHeartbeat(S, T, QUEUES, true),
  touchJobs: () => plans.touchJobs(S, T),
  failJobsByIdWithOutputs: () => plans.failJobsByIdWithOutputs(S, T),
  deadLetterJobsByIdWithOutputs: () => plans.deadLetterJobsByIdWithOutputs(S, T),
  selectJobsToFailById: () => plans.selectJobsToFailById(S, T),
  deleteJobsToFail: () => plans.deleteJobsToFail(S, T),
  selectJobsToFailByTimeout: () => plans.selectJobsToFailByTimeout(S, T, QUEUES),
  selectJobsToFailByHeartbeat: () => plans.selectJobsToFailByHeartbeat(S, T, QUEUES),
  deleteJobsByIds: () => plans.deleteJobsByIds(S, T),
  decrementDependents: () => plans.decrementDependents(S),
  resolveFlowJobs: () => plans.resolveFlowJobs(S, T, QUEUES),
  selectBlockingParents: () => plans.selectBlockingParents(S, T, QUEUES),
  'selectBlockingParents noSkipLocked': () => plans.selectBlockingParents(S, T, QUEUES, true),
  clearBlocking: () => plans.clearBlocking(S),
  insertRetryJob: () => plans.insertRetryJob(S, T),
  insertDeadLetterJob: () => plans.insertDeadLetterJob(S),
  redriveJobs: () => plans.redriveJobs(S, T),
  selectJobsToRedrive: () => plans.selectJobsToRedrive(S, T),
  insertRedriveJob: () => plans.insertRedriveJob(S),
  deletion: () => plans.deletion(S, T, QUEUES),
  'deletion noAdvisoryLocks': () => plans.deletion(S, T, QUEUES, true),
  retryJobs: () => plans.retryJobs(S, T),
  'updateJob by id': () => plans.updateJob(S, T, 'q1', 'id', 'newest'),
  'updateJob by id notify': () => plans.updateJob(S, T, 'q1', 'id', 'newest', true),
  'updateJob by key newest': () => plans.updateJob(S, T, 'q1', 'singletonKey', 'newest'),
  'updateJob by key oldest': () => plans.updateJob(S, T, 'q1', 'singletonKey', 'oldest'),
  'updateJob by key all': () => plans.updateJob(S, T, 'q1', 'singletonKey', 'all'),
  getQueueStats: () => plans.getQueueStats(S, T, QUEUES),
  cacheQueueStats: () => plans.cacheQueueStats(S, T, QUEUES),
  'cacheQueueStats noAdvisoryLocks': () => plans.cacheQueueStats(S, T, QUEUES, true),
  refreshQueueStats: () => plans.refreshQueueStats(S, T, 'q1'),
  serializeArrayParam: () => plans.serializeArrayParam(['a', "b'c"]),
  serializeJsonParam: () => plans.serializeJsonParam({ a: 1, b: "x'y" }),
  'transaction single': () => plans.transaction(S, 'SELECT 1'),
  'transaction multiple': () => plans.transaction(S, ['SELECT 1', 'SELECT 2']),
  locked: () => plans.locked(S, 'SELECT 1'),
  'locked with key': () => plans.locked(S, ['SELECT 1', 'SELECT 2'], 'key'),
  'locked noAdvisoryLocks': () => plans.locked(S, 'SELECT 1', undefined, true),
  'findJobs base': () => plans.findJobs(S, T, { queued: false, byKey: false, byData: false, byId: false }),
  'findJobs queued': () => plans.findJobs(S, T, { queued: true, byKey: false, byData: false, byId: false }),
  'findJobs byKey': () => plans.findJobs(S, T, { queued: false, byKey: true, byData: false, byId: false }),
  'findJobs byData': () => plans.findJobs(S, T, { queued: false, byKey: false, byData: true, byId: false }),
  'findJobs byId': () => plans.findJobs(S, T, { queued: false, byKey: false, byData: false, byId: true }),
  'findJobs queued byKey byData': () => plans.findJobs(S, T, { queued: true, byKey: true, byData: true, byId: false }),
  getJobById: () => plans.getJobById(S, T),
  insertDependencies: () => plans.insertDependencies(S),
  'insertDependencies inline': () => plans.insertDependencies(S, [{ child_name: 'c', child_id: '1', parent_name: 'p', parent_id: '2' }]),
  getDependencies: () => plans.getDependencies(S),
  getDependents: () => plans.getDependents(S),
  cleanupDependencies: () => plans.cleanupDependencies(S, T, QUEUES),
  'cleanupDependencies noAdvisoryLocks': () => plans.cleanupDependencies(S, T, QUEUES, true)
}

function render (value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }

  if (typeof value === 'string') {
    return value
  }

  // SqlQuery objects carry parameter values alongside the text; both are part of the contract.
  if (typeof value === 'object' && 'text' in (value as any)) {
    const { text, values } = value as { text: string, values?: unknown[] }
    return `${text}\n-- values: ${JSON.stringify(values ?? [])}`
  }

  return JSON.stringify(value, null, 2)
}

describe('plans postgres byte-identity', function () {
  it('should render every builder exactly as committed', function () {
    const document = Object.entries(cases)
      .map(([key, fn]) => `=== ${key} ===\n${render(fn())}\n`)
      .join('\n')

    const snapshotPath = new URL('./plansSnapshot.sql', import.meta.url)

    if (process.env.UPDATE_SNAPSHOTS === 'true') {
      fs.writeFileSync(snapshotPath, document)
    }

    expect(document).toBe(fs.readFileSync(snapshotPath, 'utf8'))
  })

  // The bun adapter (src/adapters/bun.ts) re-encodes a json parameter only when the SQL text
  // carries an explicit ::json/::jsonb cast, so a bare `data @> $n` would be double-encoded and
  // fail. The word boundary keeps `\d+` from giving back a digit to satisfy the lookahead, which
  // would flag a correctly cast `$12::jsonb`.
  it('should render every jsonb containment placeholder with an explicit cast', function () {
    const uncast = Object.entries(cases)
      .filter(([, fn]) => /(?:@>|<@)\s*\$\d+\b(?!\s*::\s*json)/.test(render(fn())))
      .map(([key]) => key)

    expect(uncast).toEqual([])
  })

  // The cases record is hand-maintained, so without this a new plans builder would ship with
  // unpinned postgres output (it happened: the redrive split originally landed unsnapshotted).
  it('should include every plans function export in the cases', function () {
    const covered = new Set(Object.keys(cases).map(key => key.split(' ')[0]))
    const missing = Object.entries(plans)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter(name => !covered.has(name))

    expect(missing).toEqual([])
  })
})
