import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ctx } from './helpers'

describe('db.server', () => {
  // Reset module state between tests since it uses module-level variables
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
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

  describe('query timeouts', () => {
    it('getQueryTimeoutMs defaults to 60000 and rejects garbage values', async () => {
      const { getQueryTimeoutMs } = await import('~/lib/db.server')

      expect(getQueryTimeoutMs()).toBe(60000)

      vi.stubEnv('PGBOSS_DASHBOARD_QUERY_TIMEOUT', 'abc')
      expect(getQueryTimeoutMs()).toBe(60000)

      vi.stubEnv('PGBOSS_DASHBOARD_QUERY_TIMEOUT', '-5')
      expect(getQueryTimeoutMs()).toBe(60000)

      vi.stubEnv('PGBOSS_DASHBOARD_QUERY_TIMEOUT', '30000')
      expect(getQueryTimeoutMs()).toBe(30000)
    })

    it('isQueryTimeoutError matches statement_timeout and client read timeout errors', async () => {
      const { isQueryTimeoutError } = await import('~/lib/db.server')

      expect(isQueryTimeoutError({ code: '57014' })).toBe(true)
      expect(isQueryTimeoutError(new Error('Query read timeout'))).toBe(true)
      expect(isQueryTimeoutError({ code: '42P01' })).toBe(false)
      expect(isQueryTimeoutError(new Error('boom'))).toBe(false)
      expect(isQueryTimeoutError(null)).toBe(false)
      expect(isQueryTimeoutError('57014')).toBe(false)
    })

    it('cancels queries server-side after PGBOSS_DASHBOARD_QUERY_TIMEOUT', async () => {
      vi.stubEnv('PGBOSS_DASHBOARD_QUERY_TIMEOUT', '100')
      const { query, getPool, isQueryTimeoutError } = await import('~/lib/db.server')
      // Distinct connection string so a pool cached by another test can't be reused
      const cs = ctx.connectionString + '?application_name=timeout_test'

      const err = await query(cs, 'SELECT pg_sleep(1)').catch((e: unknown) => e)

      expect(err).toMatchObject({ code: '57014' })
      expect(isQueryTimeoutError(err)).toBe(true)

      await getPool(cs).end()
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
