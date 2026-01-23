import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import { delay } from '../src/tools.ts'

const bamConfig = {
  noDefault: true,
  bamIntervalSeconds: 1,
  __test__bypass_bam_interval_check: true
}

async function insertBamCommand (schema: string, name: string, command: string) {
  const db = await helper.getDb()
  await db.executeSql(`
    INSERT INTO ${schema}.bam (name, version, status, table_name, command)
    VALUES ($1, 27, 'pending', 'job_common', $2)
  `, [name, command])
  await db.close()
}

async function triggerBamPoll (schema: string) {
  // Reset bam_on to allow processing on next poll cycle
  const db = await helper.getDb()
  await db.executeSql(`UPDATE ${schema}.version SET bam_on = NULL`)
  await db.close()
}

function waitForBamEvent (boss: any, name: string, status: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      boss.off('bam', handler)
      reject(new Error(`Timeout waiting for bam event: ${name} ${status}`))
    }, timeoutMs)

    const handler = (event: any) => {
      if (event.name === name && event.status === status) {
        clearTimeout(timeout)
        boss.off('bam', handler)
        resolve(event)
      }
    }
    boss.on('bam', handler)
  })
}

describe('bam', function () {
  describe('poll error handling', function () {
    it('should emit error when poll throws', async function () {
      const errorMessage = 'test bam poll error'
      const config = {
        ...ctx.bossConfig,
        noDefault: true,
        bamIntervalSeconds: 1,
        __test__bypass_bam_interval_check: true,
        __test__throw_bam: errorMessage
      }

      ctx.boss = new PgBoss(config)

      let errorCount = 0
      const errors: Error[] = []

      ctx.boss.on('error', (error: Error) => {
        errors.push(error)
        errorCount++
      })

      await ctx.boss.start()
      await delay(1500)

      expect(errorCount).toBeGreaterThanOrEqual(1)
      expect(errors.some(e => e.message === errorMessage)).toBe(true)
    })
  })

  describe('command error handling', function () {
    it('should mark command as failed when execution throws', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      // Suppress unhandled error events during test
      boss.on('error', () => {})

      const errorMessage = 'intentional test error'

      await insertBamCommand(
        ctx.schema,
        'test_error_1',
        `DO $$ BEGIN RAISE EXCEPTION '${errorMessage}'; END $$;`
      )

      const bamEventPromise = waitForBamEvent(boss, 'test_error_1', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const bamStatus = await boss.getBamStatus()
      const failedEntry = bamStatus.find((e: any) => e.name === 'test_error_1')

      expect(failedEntry).toBeDefined()
      expect(failedEntry.status).toBe('failed')
      expect(failedEntry.error).toContain(errorMessage)
    }, 10000)

    it('should emit error event when command fails', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })

      const errorMessage = 'test error for event'
      const errors: Error[] = []

      boss.on('error', (err: Error) => {
        errors.push(err)
      })

      await insertBamCommand(
        ctx.schema,
        'test_error_event',
        `DO $$ BEGIN RAISE EXCEPTION '${errorMessage}'; END $$;`
      )

      const bamEventPromise = waitForBamEvent(boss, 'test_error_event', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const relevantError = errors.find(e => e.message.includes(errorMessage))
      expect(relevantError).toBeDefined()
    }, 10000)

    it('should emit bam event with failed status', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const bamEvents: any[] = []
      boss.on('bam', (event: any) => {
        bamEvents.push(event)
      })

      await insertBamCommand(ctx.schema, 'test_bam_event', 'SELECT 1/0')

      const bamEventPromise = waitForBamEvent(boss, 'test_bam_event', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const inProgressEvent = bamEvents.find(e => e.name === 'test_bam_event' && e.status === 'in_progress')
      const failedEvent = bamEvents.find(e => e.name === 'test_bam_event' && e.status === 'failed')

      expect(inProgressEvent).toBeDefined()
      expect(inProgressEvent.table).toBe('job_common')

      expect(failedEvent).toBeDefined()
      expect(failedEvent.table).toBe('job_common')
      expect(failedEvent.error).toBeDefined()
    }, 10000)

    it('should continue processing after a failed command', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const db = await helper.getDb()
      await db.executeSql(`
        INSERT INTO ${ctx.schema}.bam (name, version, status, table_name, command)
        VALUES
          ('test_fail', 27, 'pending', 'job_common', 'SELECT 1/0'),
          ('test_success', 27, 'pending', 'job_common', 'SELECT 1')
      `)
      await db.close()

      const failPromise = waitForBamEvent(boss, 'test_fail', 'failed')
      const successPromise = waitForBamEvent(boss, 'test_success', 'completed', 10000)

      await triggerBamPoll(ctx.schema)
      await failPromise

      // Trigger another poll for the second command
      await triggerBamPoll(ctx.schema)
      await successPromise

      const bamStatus = await boss.getBamStatus()
      const failedEntry = bamStatus.find((e: any) => e.name === 'test_fail')
      const successEntry = bamStatus.find((e: any) => e.name === 'test_success')

      expect(failedEntry).toBeDefined()
      expect(failedEntry.status).toBe('failed')

      expect(successEntry).toBeDefined()
      expect(successEntry.status).toBe('completed')
    }, 15000)

    it('should capture error message for type cast errors', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      await insertBamCommand(ctx.schema, 'test_cast_error', 'SELECT \'not_a_number\'::int')

      const bamEventPromise = waitForBamEvent(boss, 'test_cast_error', 'failed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const bamStatus = await boss.getBamStatus()
      const entry = bamStatus.find((e: any) => e.name === 'test_cast_error')

      expect(entry).toBeDefined()
      expect(entry.status).toBe('failed')
      expect(entry.error).toBeDefined()
      expect(entry.error.length).toBeGreaterThan(0)
    }, 10000)
  })

  describe('successful execution', function () {
    it('should mark command as completed on success', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      await insertBamCommand(ctx.schema, 'test_success_1', 'SELECT 1')

      const bamEventPromise = waitForBamEvent(boss, 'test_success_1', 'completed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const bamStatus = await boss.getBamStatus()
      const entry = bamStatus.find((e: any) => e.name === 'test_success_1')

      expect(entry).toBeDefined()
      expect(entry.status).toBe('completed')
      expect(entry.completedOn).toBeDefined()
    }, 10000)

    it('should emit bam events for in_progress and completed', async function () {
      const boss = ctx.boss = await helper.start({ ...ctx.bossConfig, ...bamConfig })
      boss.on('error', () => {})

      const bamEvents: any[] = []
      boss.on('bam', (event: any) => {
        bamEvents.push(event)
      })

      await insertBamCommand(ctx.schema, 'test_events', 'SELECT 1')

      const bamEventPromise = waitForBamEvent(boss, 'test_events', 'completed')
      await triggerBamPoll(ctx.schema)
      await bamEventPromise

      const inProgressEvent = bamEvents.find(e => e.name === 'test_events' && e.status === 'in_progress')
      const completedEvent = bamEvents.find(e => e.name === 'test_events' && e.status === 'completed')

      expect(inProgressEvent).toBeDefined()
      expect(completedEvent).toBeDefined()
      expect(completedEvent.error).toBeUndefined()
    }, 10000)
  })
})
