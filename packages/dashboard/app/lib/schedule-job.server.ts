import type { ScheduleRequest } from './schedule-form'
import { SchemaVersionMismatch, withBoss } from './pg-boss.server'

export type ScheduleResult = { ok: true } | { error: string }

function failure (doing: string, error: unknown): { error: string } {
  if (error instanceof SchemaVersionMismatch) return { error: error.message }
  return { error: `Failed to ${doing}: ${error instanceof Error ? error.message : String(error)}` }
}

/** Adds a schedule through `boss.schedule()`, or replaces the one with the same queue and key. */
export async function createSchedule (dbUrl: string, schema: string, { queue, cron, data, options }: ScheduleRequest): Promise<ScheduleResult> {
  try {
    await withBoss(dbUrl, schema, (boss) => boss.schedule(queue, cron, data ?? undefined, options))
    return { ok: true }
  } catch (error) {
    return failure('schedule the job', error)
  }
}

/** Removes one schedule through `boss.unschedule()`. An empty key is the queue's schedule with no key. */
export async function removeSchedule (dbUrl: string, schema: string, queue: string, key: string): Promise<ScheduleResult> {
  try {
    await withBoss(dbUrl, schema, (boss) => boss.unschedule(queue, key || undefined))
    return { ok: true }
  } catch (error) {
    return failure('unschedule', error)
  }
}
