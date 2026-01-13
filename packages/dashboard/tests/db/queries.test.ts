import { describe, it, expect } from 'vitest'
import {
  ctx,
  insertTestQueue,
  insertTestJob,
  insertTestWarning,
} from './setup'
import {
  getQueues,
  getQueue,
  getJobs,
  getJobCountFromQueue,
  getJob,
  getWarnings,
  getWarningCount,
  getAggregateStats,
  cancelJob,
  retryJob,
  deleteJob,
  isValidIntent,
} from '~/lib/queries.server'

describe('queries.server', () => {
  describe('getQueues', () => {
    it('returns empty array when no queues exist', async () => {
      const queues = await getQueues(ctx.connectionString, ctx.schema)
      expect(queues).toEqual([])
    })

    it('returns all queues ordered by name', async () => {
      await insertTestQueue(ctx.schema, 'queue-b')
      await insertTestQueue(ctx.schema, 'queue-a')
      await insertTestQueue(ctx.schema, 'queue-c')

      const queues = await getQueues(ctx.connectionString, ctx.schema)

      expect(queues).toHaveLength(3)
      expect(queues[0].name).toBe('queue-a')
      expect(queues[1].name).toBe('queue-b')
      expect(queues[2].name).toBe('queue-c')
    })

    it('returns queue stats from cached counts', async () => {
      await insertTestQueue(ctx.schema, 'test-queue', {
        queuedCount: 10,
        activeCount: 5,
        totalCount: 100,
      })

      const queues = await getQueues(ctx.connectionString, ctx.schema)

      expect(queues[0].queuedCount).toBe(10)
      expect(queues[0].activeCount).toBe(5)
      expect(queues[0].totalCount).toBe(100)
    })
  })

  describe('getQueue', () => {
    it('returns null when queue does not exist', async () => {
      const queue = await getQueue(ctx.connectionString, ctx.schema, 'nonexistent')
      expect(queue).toBeNull()
    })

    it('returns queue by name', async () => {
      await insertTestQueue(ctx.schema, 'my-queue', {
        policy: 'singleton',
        queuedCount: 25,
      })

      const queue = await getQueue(ctx.connectionString, ctx.schema, 'my-queue')

      expect(queue).not.toBeNull()
      expect(queue!.name).toBe('my-queue')
      expect(queue!.policy).toBe('singleton')
      expect(queue!.queuedCount).toBe(25)
    })
  })

  describe('getJobs', () => {
    it('returns empty array when no jobs exist', async () => {
      await insertTestQueue(ctx.schema, 'empty-queue')

      const jobs = await getJobs(ctx.connectionString, ctx.schema, 'empty-queue')
      expect(jobs).toEqual([])
    })

    it('returns jobs for a queue', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      await insertTestJob(ctx.schema, 'test-queue', { state: 'created' })
      await insertTestJob(ctx.schema, 'test-queue', { state: 'active' })

      const jobs = await getJobs(ctx.connectionString, ctx.schema, 'test-queue')

      expect(jobs).toHaveLength(2)
    })

    it('filters jobs by state', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      await insertTestJob(ctx.schema, 'test-queue', { state: 'created' })
      await insertTestJob(ctx.schema, 'test-queue', { state: 'active' })
      await insertTestJob(ctx.schema, 'test-queue', { state: 'completed' })

      const activeJobs = await getJobs(ctx.connectionString, ctx.schema, 'test-queue', {
        state: 'active',
      })

      expect(activeJobs).toHaveLength(1)
      expect(activeJobs[0].state).toBe('active')
    })

    it('paginates jobs', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      for (let i = 0; i < 5; i++) {
        await insertTestJob(ctx.schema, 'test-queue', { priority: i })
      }

      const page1 = await getJobs(ctx.connectionString, ctx.schema, 'test-queue', {
        limit: 2,
        offset: 0,
      })
      const page2 = await getJobs(ctx.connectionString, ctx.schema, 'test-queue', {
        limit: 2,
        offset: 2,
      })

      expect(page1).toHaveLength(2)
      expect(page2).toHaveLength(2)
    })
  })

  describe('getJobCountFromQueue', () => {
    it('returns totalCount when no filter', () => {
      const queue = { totalCount: 100, activeCount: 10, queuedCount: 50 } as any
      expect(getJobCountFromQueue(queue, null)).toBe(100)
    })

    it('returns activeCount for active filter', () => {
      const queue = { totalCount: 100, activeCount: 10, queuedCount: 50 } as any
      expect(getJobCountFromQueue(queue, 'active')).toBe(10)
    })

    it('returns null for states without cached counts', () => {
      const queue = { totalCount: 100, activeCount: 10, queuedCount: 50 } as any
      expect(getJobCountFromQueue(queue, 'completed')).toBeNull()
      expect(getJobCountFromQueue(queue, 'failed')).toBeNull()
      expect(getJobCountFromQueue(queue, 'cancelled')).toBeNull()
    })

    it('returns null for created/retry (ambiguous in queuedCount)', () => {
      const queue = { totalCount: 100, activeCount: 10, queuedCount: 50 } as any
      expect(getJobCountFromQueue(queue, 'created')).toBeNull()
      expect(getJobCountFromQueue(queue, 'retry')).toBeNull()
    })
  })

  describe('getJob', () => {
    it('returns null when job does not exist', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')

      const job = await getJob(
        ctx.connectionString,
        ctx.schema,
        'test-queue',
        '00000000-0000-0000-0000-000000000000'
      )
      expect(job).toBeNull()
    })

    it('returns job by id', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      const jobId = await insertTestJob(ctx.schema, 'test-queue', {
        data: { foo: 'bar' },
        priority: 5,
      })

      const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

      expect(job).not.toBeNull()
      expect(job!.id).toBe(jobId)
      expect(job!.priority).toBe(5)
      expect(job!.data).toEqual({ foo: 'bar' })
    })
  })

  describe('getWarnings', () => {
    it('returns empty array when no warnings exist', async () => {
      const warnings = await getWarnings(ctx.connectionString, ctx.schema)
      expect(warnings).toEqual([])
    })

    it('returns warnings ordered by created_on desc', async () => {
      await insertTestWarning(ctx.schema, 'slow_query', 'First warning')
      await insertTestWarning(ctx.schema, 'queue_backlog', 'Second warning')

      const warnings = await getWarnings(ctx.connectionString, ctx.schema)

      expect(warnings).toHaveLength(2)
      // Most recent first
      expect(warnings[0].message).toBe('Second warning')
      expect(warnings[1].message).toBe('First warning')
    })

    it('filters warnings by type', async () => {
      await insertTestWarning(ctx.schema, 'slow_query', 'Slow query 1')
      await insertTestWarning(ctx.schema, 'queue_backlog', 'Backlog 1')
      await insertTestWarning(ctx.schema, 'slow_query', 'Slow query 2')

      const warnings = await getWarnings(ctx.connectionString, ctx.schema, {
        type: 'slow_query',
      })

      expect(warnings).toHaveLength(2)
      expect(warnings.every((w) => w.type === 'slow_query')).toBe(true)
    })

    it('paginates warnings', async () => {
      for (let i = 0; i < 5; i++) {
        await insertTestWarning(ctx.schema, 'slow_query', `Warning ${i}`)
      }

      const page1 = await getWarnings(ctx.connectionString, ctx.schema, {
        limit: 2,
        offset: 0,
      })
      const page2 = await getWarnings(ctx.connectionString, ctx.schema, {
        limit: 2,
        offset: 2,
      })

      expect(page1).toHaveLength(2)
      expect(page2).toHaveLength(2)
    })
  })

  describe('getWarningCount', () => {
    it('returns 0 when no warnings exist', async () => {
      const count = await getWarningCount(ctx.connectionString, ctx.schema)
      expect(count).toBe(0)
    })

    it('returns total count', async () => {
      await insertTestWarning(ctx.schema, 'slow_query', 'Warning 1')
      await insertTestWarning(ctx.schema, 'queue_backlog', 'Warning 2')
      await insertTestWarning(ctx.schema, 'clock_skew', 'Warning 3')

      const count = await getWarningCount(ctx.connectionString, ctx.schema)
      expect(count).toBe(3)
    })

    it('returns filtered count', async () => {
      await insertTestWarning(ctx.schema, 'slow_query', 'Warning 1')
      await insertTestWarning(ctx.schema, 'queue_backlog', 'Warning 2')
      await insertTestWarning(ctx.schema, 'slow_query', 'Warning 3')

      const count = await getWarningCount(ctx.connectionString, ctx.schema, 'slow_query')
      expect(count).toBe(2)
    })
  })

  describe('getAggregateStats', () => {
    it('returns zeros when no queues exist', async () => {
      const stats = await getAggregateStats(ctx.connectionString, ctx.schema)

      expect(stats.totalDeferred).toBe(0)
      expect(stats.totalQueued).toBe(0)
      expect(stats.totalActive).toBe(0)
      expect(stats.totalJobs).toBe(0)
      expect(stats.queueCount).toBe(0)
    })

    it('aggregates stats from all queues', async () => {
      await insertTestQueue(ctx.schema, 'queue-1', {
        queuedCount: 10,
        activeCount: 5,
        totalCount: 50,
      })
      await insertTestQueue(ctx.schema, 'queue-2', {
        queuedCount: 20,
        activeCount: 10,
        totalCount: 100,
      })

      const stats = await getAggregateStats(ctx.connectionString, ctx.schema)

      expect(stats.totalQueued).toBe(30)
      expect(stats.totalActive).toBe(15)
      expect(stats.totalJobs).toBe(150)
      expect(stats.queueCount).toBe(2)
    })
  })

  describe('cancelJob', () => {
    it('cancels a created job', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'created' })

      const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

      expect(result).toBe(1)

      const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
      expect(job!.state).toBe('cancelled')
    })

    it('does not cancel a completed job', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'completed' })

      const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

      expect(result).toBe(0)

      const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
      expect(job!.state).toBe('completed')
    })

    it('returns 0 for non-existent job', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')

      const result = await cancelJob(
        ctx.connectionString,
        ctx.schema,
        'test-queue',
        '00000000-0000-0000-0000-000000000000'
      )

      expect(result).toBe(0)
    })
  })

  describe('retryJob', () => {
    it('retries a failed job', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'failed' })

      const result = await retryJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

      expect(result).toBe(1)

      const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
      expect(job!.state).toBe('retry')
    })

    it('does not retry a non-failed job', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'created' })

      const result = await retryJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

      expect(result).toBe(0)

      const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
      expect(job!.state).toBe('created')
    })
  })

  describe('deleteJob', () => {
    it('deletes a job', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')
      const jobId = await insertTestJob(ctx.schema, 'test-queue')

      const result = await deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

      expect(result).toBe(1)

      const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
      expect(job).toBeNull()
    })

    it('returns 0 for non-existent job', async () => {
      await insertTestQueue(ctx.schema, 'test-queue')

      const result = await deleteJob(
        ctx.connectionString,
        ctx.schema,
        'test-queue',
        '00000000-0000-0000-0000-000000000000'
      )

      expect(result).toBe(0)
    })
  })

  describe('isValidIntent', () => {
    it('returns true for valid intents', () => {
      expect(isValidIntent('cancel')).toBe(true)
      expect(isValidIntent('retry')).toBe(true)
      expect(isValidIntent('delete')).toBe(true)
    })

    it('returns false for invalid intents', () => {
      expect(isValidIntent('invalid')).toBe(false)
      expect(isValidIntent('')).toBe(false)
      expect(isValidIntent(null)).toBe(false)
      expect(isValidIntent(undefined)).toBe(false)
      expect(isValidIntent(123)).toBe(false)
    })
  })

  describe('schema validation', () => {
    it('throws on invalid schema name', async () => {
      await expect(
        getQueues(ctx.connectionString, 'invalid; DROP TABLE users;--')
      ).rejects.toThrow('Invalid identifier')
    })

    it('allows valid schema names', async () => {
      // Using ctx.schema which is valid
      const queues = await getQueues(ctx.connectionString, ctx.schema)
      expect(queues).toEqual([])
    })
  })
})
