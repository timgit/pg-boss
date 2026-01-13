import { describe, it, expect } from 'vitest'
import type {
  QueueResult,
  JobResult,
  JobState,
  WarningResult,
  WarningType,
  AggregateStats,
} from '~/lib/types'

describe('Types', () => {
  describe('JobState', () => {
    it('includes all valid job states', () => {
      const validStates: JobState[] = [
        'created',
        'retry',
        'active',
        'completed',
        'cancelled',
        'failed',
      ]

      expect(validStates).toHaveLength(6)
      expect(validStates).toContain('created')
      expect(validStates).toContain('retry')
      expect(validStates).toContain('active')
      expect(validStates).toContain('completed')
      expect(validStates).toContain('cancelled')
      expect(validStates).toContain('failed')
    })
  })

  describe('WarningType', () => {
    it('includes all valid warning types', () => {
      const validTypes: WarningType[] = [
        'slow_query',
        'queue_backlog',
        'clock_skew',
      ]

      expect(validTypes).toHaveLength(3)
      expect(validTypes).toContain('slow_query')
      expect(validTypes).toContain('queue_backlog')
      expect(validTypes).toContain('clock_skew')
    })
  })

  describe('QueueResult', () => {
    it('has required queue properties', () => {
      const queue: QueueResult = {
        name: 'test-queue',
        policy: 'standard',
        partition: false,
        deadLetter: null,
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: false,
        retryDelayMax: null,
        expireSeconds: 3600,
        retentionSeconds: 86400,
        deletionSeconds: 0,
        deferredCount: 10,
        queuedCount: 50,
        activeCount: 5,
        totalCount: 100,
        warningQueued: 1000,
        singletonsActive: null,
        monitorOn: null,
        maintainOn: null,
        createdOn: new Date(),
        updatedOn: new Date(),
      }

      expect(queue.name).toBe('test-queue')
      expect(queue.policy).toBe('standard')
      expect(queue.queuedCount).toBe(50)
      expect(queue.activeCount).toBe(5)
      expect(queue.totalCount).toBe(100)
    })

    it('supports optional tableName property', () => {
      const queue: QueueResult = {
        name: 'test',
        policy: 'standard',
        partition: false,
        deadLetter: null,
        retryLimit: 2,
        retryDelay: 0,
        retryBackoff: false,
        retryDelayMax: null,
        expireSeconds: 900,
        retentionSeconds: 86400,
        deletionSeconds: 604800,
        deferredCount: 0,
        queuedCount: 0,
        activeCount: 0,
        totalCount: 0,
        warningQueued: 0,
        singletonsActive: null,
        tableName: 'job_test',
        monitorOn: null,
        maintainOn: null,
        createdOn: new Date(),
        updatedOn: new Date(),
      }

      expect(queue.tableName).toBe('job_test')
    })
  })

  describe('JobResult', () => {
    it('has required job properties', () => {
      const now = new Date()
      const job: JobResult = {
        id: 'test-job-id',
        name: 'test-queue',
        data: { foo: 'bar' },
        state: 'created',
        priority: 0,
        retryCount: 0,
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: false,
        startAfter: now,
        startedOn: null,
        completedOn: null,
        createdOn: now,
        keepUntil: now,
        output: null,
        singletonKey: null,
        groupId: null,
        groupTier: null,
        deadLetter: null,
        policy: null,
      }

      expect(job.id).toBe('test-job-id')
      expect(job.name).toBe('test-queue')
      expect(job.state).toBe('created')
      expect(job.data).toEqual({ foo: 'bar' })
    })

    it('supports all job states', () => {
      const states: JobState[] = ['created', 'retry', 'active', 'completed', 'cancelled', 'failed']

      states.forEach((state) => {
        const job: JobResult = {
          id: 'id',
          name: 'queue',
          data: null,
          state,
          priority: 0,
          retryCount: 0,
          retryLimit: 2,
          retryDelay: 0,
          retryBackoff: false,
          startAfter: new Date(),
          startedOn: null,
          completedOn: null,
          createdOn: new Date(),
          keepUntil: new Date(),
          output: null,
          singletonKey: null,
          groupId: null,
          groupTier: null,
          deadLetter: null,
          policy: null,
        }

        expect(job.state).toBe(state)
      })
    })
  })

  describe('WarningResult', () => {
    it('has required warning properties', () => {
      const warning: WarningResult = {
        id: 1,
        type: 'slow_query',
        message: 'Query took 35.2 seconds',
        data: { elapsed: 35.2, sql: 'SELECT * FROM big_table' },
        createdOn: new Date(),
      }

      expect(warning.id).toBe(1)
      expect(warning.type).toBe('slow_query')
      expect(warning.message).toContain('35.2')
      expect(warning.data).toEqual({ elapsed: 35.2, sql: 'SELECT * FROM big_table' })
    })
  })

  describe('AggregateStats', () => {
    it('has required stats properties', () => {
      const stats: AggregateStats = {
        totalDeferred: 100,
        totalQueued: 500,
        totalActive: 50,
        totalJobs: 10000,
        queueCount: 10,
      }

      expect(stats.totalDeferred).toBe(100)
      expect(stats.totalQueued).toBe(500)
      expect(stats.totalActive).toBe(50)
      expect(stats.totalJobs).toBe(10000)
      expect(stats.queueCount).toBe(10)
    })
  })
})
