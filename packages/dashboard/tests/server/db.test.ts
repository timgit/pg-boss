import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ctx } from './helpers'

describe('db.server', () => {
  // Reset module state between tests since it uses module-level variables
  beforeEach(() => {
    vi.resetModules()
  })

  describe('getPool', () => {
    it('creates and caches a pool', async () => {
      const { getPool } = await import('~/lib/db.server')

      const pool1 = getPool(ctx.connectionString)
      const pool2 = getPool(ctx.connectionString)

      expect(pool1).toBe(pool2) // Same cached instance

      await pool1.end()
    })

    it('creates separate pools for different connection strings', async () => {
      const { getPool } = await import('~/lib/db.server')

      const pool1 = getPool(ctx.connectionString)
      // Use a slightly different connection string (add a query param)
      const pool2 = getPool(ctx.connectionString + '?application_name=test')

      expect(pool1).not.toBe(pool2)

      await pool1.end()
      await pool2.end()
    })

    it('throws when shutting down', async () => {
      const { getPool, closeAllPools } = await import('~/lib/db.server')

      // Create a pool first
      const pool = getPool(ctx.connectionString)
      expect(pool).toBeDefined()

      // Trigger shutdown
      await closeAllPools()

      // Now getPool should throw
      expect(() => getPool(ctx.connectionString)).toThrow('Database pool is shutting down')
    })
  })

  describe('query', () => {
    it('executes queries and returns rows', async () => {
      const { query, getPool } = await import('~/lib/db.server')

      const result = await query<{ one: number }>(ctx.connectionString, 'SELECT 1 as one')

      expect(result).toEqual([{ one: 1 }])

      await getPool(ctx.connectionString).end()
    })

    it('supports parameterized queries', async () => {
      const { query, getPool } = await import('~/lib/db.server')

      const result = await query<{ sum: number }>(
        ctx.connectionString,
        'SELECT $1::int + $2::int as sum',
        [2, 3]
      )

      expect(result).toEqual([{ sum: 5 }])

      await getPool(ctx.connectionString).end()
    })
  })

  describe('queryOne', () => {
    it('returns first row or null', async () => {
      const { queryOne, getPool } = await import('~/lib/db.server')

      const result = await queryOne<{ value: number }>(
        ctx.connectionString,
        'SELECT 42 as value'
      )

      expect(result).toEqual({ value: 42 })

      await getPool(ctx.connectionString).end()
    })

    it('returns null for empty result', async () => {
      const { queryOne, getPool } = await import('~/lib/db.server')

      const result = await queryOne<{ value: number }>(
        ctx.connectionString,
        'SELECT 1 as value WHERE false'
      )

      expect(result).toBeNull()

      await getPool(ctx.connectionString).end()
    })
  })

  describe('closeAllPools', () => {
    it('closes all pools', async () => {
      const { getPool, closeAllPools } = await import('~/lib/db.server')

      // Create pools
      const pool1 = getPool(ctx.connectionString)
      const pool2 = getPool(ctx.connectionString + '?application_name=test2')

      // Verify they're working
      await pool1.query('SELECT 1')
      await pool2.query('SELECT 1')

      // Close all
      await closeAllPools()

      // Pools should be ended (queries will fail)
      await expect(pool1.query('SELECT 1')).rejects.toThrow()
      await expect(pool2.query('SELECT 1')).rejects.toThrow()
    })
  })

  describe('pool error handling', () => {
    it('handles pool errors without crashing', async () => {
      const { getPool } = await import('~/lib/db.server')
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const pool = getPool(ctx.connectionString)

      // Emit an error event on the pool
      pool.emit('error', new Error('Test pool error'))

      expect(consoleSpy).toHaveBeenCalledWith(
        'Unexpected database pool error:',
        expect.any(Error)
      )

      consoleSpy.mockRestore()
      await pool.end()
    })
  })
})
