import { describe, it, expect } from 'vitest'
import {
  ctx,
  insertTestQueue,
  insertTestJob,
  insertTestWarning,
} from './setup'
import {
  getQueues,
  getQueueCount,
  getProblemQueues,
  deleteOldWarnings,
  deleteJob,
  retryJob,
  cancelJob,
  getJob,
} from '~/lib/queries.server'
import pg from 'pg'

const { Pool } = pg

describe('queries.server - extended', () => {
  describe('getQueues with pagination', () => {
    it('returns all queues when no pagination specified', async () => {
      await insertTestQueue(ctx.schema, 'queue-a')
      await insertTestQueue(ctx.schema, 'queue-b')
      await insertTestQueue(ctx.schema, 'queue-c')

      const queues = await getQueues(ctx.connectionString, ctx.schema)

      expect(queues).toHaveLength(3)
    })

    it('respects limit parameter', async () => {
      await insertTestQueue(ctx.schema, 'queue-a')
      await insertTestQueue(ctx.schema, 'queue-b')
      await insertTestQueue(ctx.schema, 'queue-c')

      const queues = await getQueues(ctx.connectionString, ctx.schema, { limit: 2 })

      expect(queues).toHaveLength(2)
      expect(queues[0].name).toBe('queue-a')
      expect(queues[1].name).toBe('queue-b')
    })

    it('respects offset parameter', async () => {
      await insertTestQueue(ctx.schema, 'queue-a')
      await insertTestQueue(ctx.schema, 'queue-b')
      await insertTestQueue(ctx.schema, 'queue-c')

      const queues = await getQueues(ctx.connectionString, ctx.schema, { limit: 2, offset: 1 })

      expect(queues).toHaveLength(2)
      expect(queues[0].name).toBe('queue-b')
      expect(queues[1].name).toBe('queue-c')
    })
  })

  describe('getQueueCount', () => {
    it('returns 0 when no queues exist', async () => {
      const count = await getQueueCount(ctx.connectionString, ctx.schema)
      expect(count).toBe(0)
    })

    it('returns correct count', async () => {
      await insertTestQueue(ctx.schema, 'queue-1')
      await insertTestQueue(ctx.schema, 'queue-2')
      await insertTestQueue(ctx.schema, 'queue-3')

      const count = await getQueueCount(ctx.connectionString, ctx.schema)
      expect(count).toBe(3)
    })
  })

  describe('getProblemQueues', () => {
    it('returns empty array when no problem queues', async () => {
      // Queue with warning threshold but below it
      const pool = new Pool({ connectionString: ctx.connectionString })
      await pool.query(`
        INSERT INTO ${ctx.schema}.queue (name, warning_queued, queued_count)
        VALUES ('normal-queue', 100, 50)
      `)
      await pool.end()

      const problems = await getProblemQueues(ctx.connectionString, ctx.schema)
      expect(problems).toEqual([])
    })

    it('returns queues exceeding their warning threshold', async () => {
      const pool = new Pool({ connectionString: ctx.connectionString })
      // Problem queue - queued_count > warning_queued
      await pool.query(`
        INSERT INTO ${ctx.schema}.queue (name, warning_queued, queued_count)
        VALUES ('problem-queue', 100, 200)
      `)
      // Normal queue
      await pool.query(`
        INSERT INTO ${ctx.schema}.queue (name, warning_queued, queued_count)
        VALUES ('normal-queue', 100, 50)
      `)
      await pool.end()

      const problems = await getProblemQueues(ctx.connectionString, ctx.schema)

      expect(problems).toHaveLength(1)
      expect(problems[0].name).toBe('problem-queue')
    })

    it('orders by backlog severity (highest first)', async () => {
      const pool = new Pool({ connectionString: ctx.connectionString })
      await pool.query(`
        INSERT INTO ${ctx.schema}.queue (name, warning_queued, queued_count)
        VALUES
          ('minor-problem', 100, 150),
          ('major-problem', 100, 500),
          ('medium-problem', 100, 250)
      `)
      await pool.end()

      const problems = await getProblemQueues(ctx.connectionString, ctx.schema)

      expect(problems).toHaveLength(3)
      expect(problems[0].name).toBe('major-problem')
      expect(problems[1].name).toBe('medium-problem')
      expect(problems[2].name).toBe('minor-problem')
    })

    it('respects limit parameter', async () => {
      const pool = new Pool({ connectionString: ctx.connectionString })
      await pool.query(`
        INSERT INTO ${ctx.schema}.queue (name, warning_queued, queued_count)
        VALUES
          ('problem-1', 10, 100),
          ('problem-2', 10, 200),
          ('problem-3', 10, 300)
      `)
      await pool.end()

      const problems = await getProblemQueues(ctx.connectionString, ctx.schema, 2)

      expect(problems).toHaveLength(2)
    })

    it('ignores queues with zero warning_queued', async () => {
      const pool = new Pool({ connectionString: ctx.connectionString })
      await pool.query(`
        INSERT INTO ${ctx.schema}.queue (name, warning_queued, queued_count)
        VALUES ('no-threshold', 0, 1000)
      `)
      await pool.end()

      const problems = await getProblemQueues(ctx.connectionString, ctx.schema)
      expect(problems).toEqual([])
    })
  })

  describe('deleteOldWarnings', () => {
    it('returns 0 when no old warnings exist', async () => {
      // Insert recent warning
      await insertTestWarning(ctx.schema, 'slow_query', 'Recent warning')

      const deleted = await deleteOldWarnings(ctx.connectionString, ctx.schema, 1)
      expect(deleted).toBe(0)
    })

    it('deletes warnings older than specified days', async () => {
      const pool = new Pool({ connectionString: ctx.connectionString })
      // Insert old warning (40 days ago)
      await pool.query(`
        INSERT INTO ${ctx.schema}.warning (type, message, created_on)
        VALUES ('slow_query', 'Old warning', now() - interval '40 days')
      `)
      // Insert recent warning
      await pool.query(`
        INSERT INTO ${ctx.schema}.warning (type, message, created_on)
        VALUES ('slow_query', 'Recent warning', now())
      `)
      await pool.end()

      const deleted = await deleteOldWarnings(ctx.connectionString, ctx.schema, 30)

      expect(deleted).toBe(1)
    })
  })

  describe('job action edge cases', () => {
    describe('deleteJob', () => {
      it('does not delete active jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'active' })

        const result = await deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(0)

        // Verify job still exists
        const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
        expect(job).not.toBeNull()
        expect(job!.state).toBe('active')
      })

      it('deletes completed jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'completed' })

        const result = await deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)

        const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
        expect(job).toBeNull()
      })

      it('deletes failed jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'failed' })

        const result = await deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)
      })

      it('deletes cancelled jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'cancelled' })

        const result = await deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)
      })

      it('deletes created jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'created' })

        const result = await deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)
      })
    })

    describe('retryJob', () => {
      it('only retries failed jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')

        const states = ['created', 'retry', 'active', 'completed', 'cancelled']

        for (const state of states) {
          const jobId = await insertTestJob(ctx.schema, 'test-queue', { state })
          const result = await retryJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
          expect(result).toBe(0)
        }
      })

      it('retries failed jobs successfully', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'failed' })

        const result = await retryJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)

        const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
        expect(job!.state).toBe('retry')
      })
    })

    describe('cancelJob', () => {
      it('cancels created jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'created' })

        const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)

        const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
        expect(job!.state).toBe('cancelled')
      })

      it('cancels retry jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'retry' })

        const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)
      })

      it('cancels active jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'active' })

        const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(1)
      })

      it('does not cancel completed jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'completed' })

        const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(0)
      })

      it('does not cancel cancelled jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'cancelled' })

        const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(0)
      })

      it('does not cancel failed jobs', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'failed' })

        const result = await cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)

        expect(result).toBe(0)
      })
    })

    describe('concurrent operations', () => {
      it('handles concurrent cancellation attempts gracefully', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'created' })

        // Simulate two concurrent cancellation attempts
        const [result1, result2] = await Promise.all([
          cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId),
          cancelJob(ctx.connectionString, ctx.schema, 'test-queue', jobId),
        ])

        // One should succeed, one should fail
        expect(result1 + result2).toBe(1)

        const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
        expect(job!.state).toBe('cancelled')
      })

      it('handles concurrent delete attempts gracefully', async () => {
        await insertTestQueue(ctx.schema, 'test-queue')
        const jobId = await insertTestJob(ctx.schema, 'test-queue', { state: 'completed' })

        // Simulate two concurrent deletion attempts
        const [result1, result2] = await Promise.all([
          deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId),
          deleteJob(ctx.connectionString, ctx.schema, 'test-queue', jobId),
        ])

        // One should succeed, one should fail
        expect(result1 + result2).toBe(1)

        const job = await getJob(ctx.connectionString, ctx.schema, 'test-queue', jobId)
        expect(job).toBeNull()
      })
    })
  })
})
