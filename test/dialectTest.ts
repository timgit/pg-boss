import { expect } from 'vitest'
import * as plans from '../src/plans.ts'
import { JOB_STATE_ORDER, POSTGRES, SQLITE, toSqliteTimestamp, type JobStateName } from '../src/dialect.ts'

// Guards for the silent-correctness traps of the sqlite dialect: enum ordinal comparisons
// rendered as IN-lists, the fixed-width timestamp text format, and postgres-only constructs
// leaking into sqlite-rendered SQL.

const S = 'pgboss'
const T = 'job'
const QUEUES = ['q1', 'q2']

describe('dialect', function () {
  describe('job state order', function () {
    it('matches plans.JOB_STATES declaration order', function () {
      expect([...JOB_STATE_ORDER]).toEqual(Object.keys(plans.JOB_STATES))
    })

    it('sqlite IN-lists partition states exactly like postgres ordinal comparisons', function () {
      const states = [...JOB_STATE_ORDER]

      for (const pivot of states) {
        for (const probe of states) {
          const pivotIndex = states.indexOf(pivot)
          const probeIndex = states.indexOf(probe)

          const inList = (rendered: string) => rendered.includes(`'${probe}'`)

          expect(inList(SQLITE.stateLt('state', pivot as JobStateName))).toBe(probeIndex < pivotIndex)
          expect(inList(SQLITE.stateLte('state', pivot as JobStateName))).toBe(probeIndex <= pivotIndex)
          expect(inList(SQLITE.stateGt('state', pivot as JobStateName))).toBe(probeIndex > pivotIndex)
        }
      }
    })

    it('postgres primitives render the original ordinal comparisons', function () {
      expect(POSTGRES.stateLt('state', 'active')).toBe("state < 'active'")
      expect(POSTGRES.stateLte('state', 'active')).toBe("state <= 'active'")
      expect(POSTGRES.stateGt('state', 'active')).toBe("state > 'active'")
    })
  })

  describe('schema qualification', function () {
    it('resolves quoted and bare schema names like postgres before quoting', function () {
      expect(SQLITE.qualify('"MySchema"', 'job')).toBe('"MySchema.job"')
      expect(SQLITE.qualify('MySchema', 'job')).toBe('"myschema.job"')
      expect(SQLITE.qualify('pgboss', 'job')).toBe('"pgboss.job"')
      expect(SQLITE.qualifyIndex('"MySchema"', 'job_i1')).toBe('"MySchema.job_i1"')
    })
  })

  describe('timestamp format', function () {
    it('binds Dates in the exact shape strftime %fZ produces', function () {
      const rendered = toSqliteTimestamp(new Date('2026-01-02T03:04:05.678Z'))
      expect(rendered).toBe('2026-01-02T03:04:05.678Z')
      expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })
  })

  describe('sqlite rendering lint', function () {
    // Render every sqlite-reachable builder and reject postgres-only constructs. Loud runtime
    // failures ("no such function") become unit-speed failures that name the builder.
    const sqliteCtx = { schema: S, dialect: SQLITE }

    const cases: Record<string, () => unknown> = {
      create: () => plans.create(sqliteCtx, 37),
      createQueue: () => plans.createQueue(sqliteCtx, 'q1', { policy: 'standard' }, true),
      deleteQueue: () => plans.deleteQueue(sqliteCtx, 'q1', true),
      updateQueue: () => plans.updateQueue(sqliteCtx),
      getQueues: () => plans.getQueues(sqliteCtx, QUEUES),
      getQueueStats: () => plans.getQueueStats(sqliteCtx, T, QUEUES),
      getQueueStatsCache: () => plans.getQueueStatsCache(sqliteCtx),
      cacheQueueStats: () => plans.cacheQueueStats(sqliteCtx, T, QUEUES, true),
      refreshQueueStats: () => plans.refreshQueueStats(sqliteCtx, T, 'q1'),
      insertJobs: () => plans.insertJobs(sqliteCtx, { table: T, name: 'q1' }),
      fetchNextJob: () => plans.fetchNextJob({ schema: S, dialect: SQLITE, table: T, name: 'q1', policy: 'standard', limit: 2, includeMetadata: true, ignoreSingletons: ['a'], ignoreGroups: ['g'], groupConcurrency: { default: 2, tiers: { gold: 5 } }, minPriority: 1, maxPriority: 9 }).text,
      completeJobs: () => plans.completeJobsNoCte(sqliteCtx, T, true),
      completeJobsWithOutputs: () => plans.completeJobsWithOutputsNoCte(sqliteCtx, T),
      cancelJobs: () => plans.cancelJobs(sqliteCtx, T),
      resumeJobs: () => plans.resumeJobs(sqliteCtx, T),
      retryJobs: () => plans.retryJobs(sqliteCtx, T),
      touchJobs: () => plans.touchJobs(sqliteCtx, T),
      deleteJobsById: () => plans.deleteJobsById(sqliteCtx, T),
      deleteJobsByIds: () => plans.deleteJobsByIds(sqliteCtx, T).text,
      deleteQueuedJobs: () => plans.deleteQueuedJobs(sqliteCtx, T),
      deleteStoredJobs: () => plans.deleteStoredJobs(sqliteCtx, T),
      deleteAllJobs: () => plans.deleteAllJobs(sqliteCtx, T),
      truncateTable: () => plans.truncateTable(sqliteCtx, T),
      selectJobsToFailById: () => plans.selectJobsToFailById(sqliteCtx, T).text,
      deleteJobsToFail: () => plans.deleteJobsToFail(sqliteCtx, T).text,
      selectJobsToFailByTimeout: () => plans.selectJobsToFailByTimeout(sqliteCtx, T, QUEUES).text,
      selectJobsToFailByHeartbeat: () => plans.selectJobsToFailByHeartbeat(sqliteCtx, T, QUEUES).text,
      insertRetryJob: () => plans.insertRetryJob(sqliteCtx, T),
      insertDeadLetterJob: () => plans.insertDeadLetterJob(sqliteCtx),
      selectJobsToRedrive: () => plans.selectJobsToRedrive(sqliteCtx, T).text,
      insertRedriveJob: () => plans.insertRedriveJob(sqliteCtx),
      deletion: () => plans.deletion(sqliteCtx, T, QUEUES, true),
      cleanupDependencies: () => plans.cleanupDependencies(sqliteCtx, T, QUEUES, true),
      trySetCronTime: () => plans.trySetCronTime(sqliteCtx, 60),
      trySetFlowTime: () => plans.trySetFlowTime(sqliteCtx, 60),
      trySetQueueMonitorTime: () => plans.trySetQueueMonitorTime(sqliteCtx, QUEUES, 60).text,
      trySetQueueDeletionTime: () => plans.trySetQueueDeletionTime(sqliteCtx, QUEUES, 60).text,
      getTime: () => plans.getTime(sqliteCtx),
      versionTableExists: () => plans.versionTableExists(sqliteCtx),
      getVersion: () => plans.getVersion(sqliteCtx),
      setVersion: () => plans.setVersion(sqliteCtx, 37),
      schedule: () => plans.schedule(sqliteCtx),
      unschedule: () => plans.unschedule(sqliteCtx),
      getSchedules: () => plans.getSchedules(sqliteCtx),
      getSchedulesByQueue: () => plans.getSchedulesByQueue(sqliteCtx),
      getSchedulesByQueueAndKey: () => plans.getSchedulesByQueueAndKey(sqliteCtx),
      updateJobById: () => plans.updateJob(sqliteCtx, T, 'q1', 'id', 'newest'),
      updateJobByKey: () => plans.updateJob(sqliteCtx, T, 'q1', 'singletonKey', 'oldest'),
      findJobs: () => plans.findJobs(sqliteCtx, T, { queued: true, byKey: true, byData: true, byId: true }),
      getJobById: () => plans.getJobById(sqliteCtx, T),
      insertDependencies: () => plans.insertDependencies(sqliteCtx),
      getDependencies: () => plans.getDependencies(sqliteCtx),
      getDependents: () => plans.getDependents(sqliteCtx),
      decrementDependents: () => plans.decrementDependents(sqliteCtx),
      selectBlockingParents: () => plans.selectBlockingParents(sqliteCtx, T, QUEUES, true).text,
      clearBlocking: () => plans.clearBlocking(sqliteCtx)
    }

    // Postgres-only constructs that must never appear in sqlite-rendered SQL. Word-boundary
    // regexes so identifiers like `singletons_active` don't false-positive.
    const forbidden: Array<[string, RegExp]> = [
      [':: cast', /::\w/],
      ['now()', /\bnow\s*\(/i],
      ['ANY(...)', /=\s*ANY\s*\(/i],
      ['ALL(...)', /\bALL\s*\(\s*\$/i],
      ['FOR UPDATE', /\bFOR\s+UPDATE\b/i],
      ['relational state comparison', /\bstate\s*[<>]=?\s*'/],
      ['interval arithmetic', /\binterval\s+'/i],
      ['unnest', /\bunnest\s*\(/i],
      ['jsonb function', /\bjsonb_\w+\s*\(/i],
      ['json_to_recordset', /\bjson_to_recordset\b/i],
      ['gen_random_uuid', /\bgen_random_uuid\b/i],
      ['pg_catalog object', /\bpg_\w+\b/],
      ['dollar quoting', /\$\$|\$cmd\$/],
      ['SET LOCAL', /\bSET\s+LOCAL\b/i],
      ['TRUNCATE', /\bTRUNCATE\b/i],
      ['interval cast', /\bAS\s+interval\b/i],
      ['GREATEST/LEAST', /\b(?:GREATEST|LEAST)\s*\(/i],
      ['EXTRACT', /\bEXTRACT\s*\(/i],
      ['unquoted schema qualification', new RegExp(`(?<!["'])\\b${S}\\.`)]
    ]

    for (const [name, render] of Object.entries(cases)) {
      it(`renders ${name} without postgres-only constructs`, function () {
        // Unwrap SqlQuery objects so a builder whose return type changes can't silently become
        // "[object Object]" and exempt itself from the lint.
        const rendered = render() as any
        const sql = typeof rendered === 'object' && rendered !== null && 'text' in rendered ? rendered.text : String(rendered)

        for (const [label, pattern] of forbidden) {
          expect(sql, `${name} rendered a ${label}: ${sql.match(pattern)?.[0]}`).not.toMatch(pattern)
        }
      })
    }
  })
})
