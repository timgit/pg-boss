import type EventEmitter from 'node:events'
import * as plans from './plans.ts'
import type * as types from './types.ts'

export interface WarningContext {
  emitter: EventEmitter
  db: types.IDatabase
  schema: string
  persistWarnings?: boolean
  warningEvent: string
  errorEvent: string
}

/**
 * Emits a warning event and optionally persists it to the database.
 * This is a shared utility to avoid duplicating warning persistence logic
 * across boss.ts and timekeeper.ts.
 */
export async function emitAndPersistWarning (
  ctx: WarningContext,
  type: string,
  message: string,
  data: object
): Promise<void> {
  ctx.emitter.emit(ctx.warningEvent, { message, data })

  if (ctx.persistWarnings) {
    try {
      const sql = plans.insertWarning(ctx.schema)
      await ctx.db.executeSql(sql, [type, message, JSON.stringify(data)])
    } catch (err) {
      ctx.emitter.emit(ctx.errorEvent, err)
    }
  }
}
