import { expect } from 'vitest'
import * as plans from '../src/plans.ts'

// Byte-identity guard for the postgres dialect: every SQL-producing plans builder is rendered
// with fixed inputs and compared against the committed snapshot, so the dialect-seam refactor
// (and any future change) cannot alter postgres output without the diff being reviewed.
// Update deliberately with: bun --bun vitest run test/plansSnapshotTest.ts -u

const S = 'pgboss'
const T = 'job'
const QUEUES = ['q1', 'q2']
const BAM_COMMAND = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS job_i5 ON pgboss.job (name, start_after)'

const fetchBase = {
  schema: S,
  table: T,
  name: 'q1',
  policy: 'standard' as string | undefined,
  limit: 1,
  ignoreSingletons: null
}

const cases: Record<string, () => unknown> = {
  'create default': () => plans.create(S, 37),
  'create with schema': () => plans.create(S, 37, { createSchema: true }),
  'create all flags': () => plans.create(S, 37, { createSchema: true, noTablePartitioning: true, noDeferrableConstraints: true, noAdvisoryLocks: true, noCoveringIndexes: true }),
  createTableWarning: () => plans.createTableWarning(S),
  createIndexWarning: () => plans.createIndexWarning(S),
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
  trySetBamTime: () => plans.trySetBamTime(S, 60),
  trySetFlowTime: () => plans.trySetFlowTime(S, 60),
  updateQueue: () => plans.updateQueue(S),
  'updateQueue deadLetter': () => plans.updateQueue(S, { deadLetter: 'dlq' }),
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
  subscribe: () => plans.subscribe(S),
  unsubscribe: () => plans.unsubscribe(S),
  getQueuesForEvent: () => plans.getQueuesForEvent(S),
  getTime: () => plans.getTime(S),
  insertWarning: () => plans.insertWarning(S),
  getWarnings: () => plans.getWarnings(S),
  getWarningsCount: () => plans.getWarningsCount(S),
  deleteOldWarnings: () => plans.deleteOldWarnings(S, 30),
  createTableQueueStats: () => plans.createTableQueueStats(S),
  'createTableQueueStats noPartitioning': () => plans.createTableQueueStats(S, true),
  createIndexQueueStats: () => plans.createIndexQueueStats(S),
  'createIndexQueueStats noCoveringIndex': () => plans.createIndexQueueStats(S, true),
  ensureQueueStatsPartitions: () => plans.ensureQueueStatsPartitions(S),
  dropOldQueueStatsPartitions: () => plans.dropOldQueueStatsPartitions(S, 30),
  deleteOldQueueStats: () => plans.deleteOldQueueStats(S, 30),
  insertQueueStats: () => plans.insertQueueStats(S, QUEUES),
  'insertQueueStats noAdvisoryLocks': () => plans.insertQueueStats(S, QUEUES, true),
  getQueueStatsCache: () => plans.getQueueStatsCache(S),
  getQueueStatsHistory: () => plans.getQueueStatsHistory(S),
  'getQueueStatsHistoryBucketed max bucket': () => plans.getQueueStatsHistoryBucketed(S, 'max', 'bucket'),
  'getQueueStatsHistoryBucketed min bucket': () => plans.getQueueStatsHistoryBucketed(S, 'min', 'bucket'),
  'getQueueStatsHistoryBucketed avg auto': () => plans.getQueueStatsHistoryBucketed(S, 'avg', 'auto'),
  getVersion: () => plans.getVersion(S),
  setVersion: () => plans.setVersion(S, 37),
  versionTableExists: () => plans.versionTableExists(S),
  getSchemaCaseVariants: () => plans.getSchemaCaseVariants(S),
  getPartitionedQueueTables: () => plans.getPartitionedQueueTables(S),
  insertVersion: () => plans.insertVersion(S, 37),
  'fetchNextJob base': () => plans.fetchNextJob({ ...fetchBase }),
  'fetchNextJob noSkipLocked': () => plans.fetchNextJob({ ...fetchBase }, true),
  'fetchNextJob metadata': () => plans.fetchNextJob({ ...fetchBase, includeMetadata: true }),
  'fetchNextJob singleton batch': () => plans.fetchNextJob({ ...fetchBase, policy: 'singleton', limit: 5 }),
  'fetchNextJob stately batch': () => plans.fetchNextJob({ ...fetchBase, policy: 'stately', limit: 5 }),
  'fetchNextJob exclusive': () => plans.fetchNextJob({ ...fetchBase, policy: 'exclusive' }),
  'fetchNextJob key_strict_fifo': () => plans.fetchNextJob({ ...fetchBase, policy: 'key_strict_fifo' }),
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
  completeJobsWithOutputsDistributed: () => plans.completeJobsWithOutputsDistributed(S, T),
  completeJobsDistributed: () => plans.completeJobsDistributed(S, T),
  'completeJobsDistributed includeQueued': () => plans.completeJobsDistributed(S, T, true),
  cancelJobs: () => plans.cancelJobs(S, T),
  resumeJobs: () => plans.resumeJobs(S, T),
  restoreJobs: () => plans.restoreJobs(S, T),
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
  assertMigration: () => plans.assertMigration(S, 37),
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
  'cleanupDependencies noAdvisoryLocks': () => plans.cleanupDependencies(S, T, QUEUES, true),
  getBlockedKeys: () => plans.getBlockedKeys(S, T),
  getNextBamCommand: () => plans.getNextBamCommand(S),
  'getNextBamCommand liveness': () => plans.getNextBamCommand(S, { useLiveness: true }),
  bamHealDrop: () => plans.bamHealDrop(S, BAM_COMMAND),
  bamHealProbe: () => plans.bamHealProbe(S, BAM_COMMAND),
  setBamCompleted: () => plans.setBamCompleted(S, 'id1'),
  setBamFailed: () => plans.setBamFailed(S, 'id1', 'boom'),
  getBamStatus: () => plans.getBamStatus(S),
  getBamEntries: () => plans.getBamEntries(S),
  jobCommonExists: () => plans.jobCommonExists(S),
  getManagedQueuePartitions: () => plans.getManagedQueuePartitions(S),
  getIncompleteBamCommands: () => plans.getIncompleteBamCommands(S),
  bamCommandIndexName: () => plans.bamCommandIndexName(BAM_COMMAND),
  EXPECTED_JOB_STATES: () => plans.EXPECTED_JOB_STATES,
  'expectedManagedTables partitioned': () => plans.expectedManagedTables(S, true, [{ table: 'j_q1' }]),
  'expectedManagedTables nonPartitioned': () => plans.expectedManagedTables(S, false),
  'expectedManagedColumns partitioned': () => plans.expectedManagedColumns(S, true, [{ table: 'j_q1' }]),
  'expectedManagedColumns nonPartitioned': () => plans.expectedManagedColumns(S, false),
  'expectedManagedConstraints partitioned': () => plans.expectedManagedConstraints(S, true),
  'expectedManagedConstraints nonPartitioned': () => plans.expectedManagedConstraints(S, false),
  'expectedManagedFunctions partitioned': () => plans.expectedManagedFunctions(S, true),
  'expectedManagedFunctions nonPartitioned': () => plans.expectedManagedFunctions(S, false),
  'expectedManagedIndexes partitioned': () => plans.expectedManagedIndexes(S, true, [{ table: 'j_q1', policy: 'short' }]),
  'expectedManagedIndexes nonPartitioned': () => plans.expectedManagedIndexes(S, false)
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
  it('should render every builder exactly as committed', async function () {
    const document = Object.entries(cases)
      .map(([key, fn]) => `=== ${key} ===\n${render(fn())}\n`)
      .join('\n')

    await expect(document).toMatchFileSnapshot('./plansSnapshot.sql')
  })
})
