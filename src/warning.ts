import type EventEmitter from 'node:events'

export interface WarningContext {
  emitter: EventEmitter
  warningEvent: string
}

/**
 * Emits a warning event. Shared by boss.ts and timekeeper.ts so the warning shape stays consistent.
 */
export function emitWarning (
  ctx: WarningContext,
  message: string,
  data: object
): void {
  ctx.emitter.emit(ctx.warningEvent, { message, data })
}
