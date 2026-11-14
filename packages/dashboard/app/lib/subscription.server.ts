import type { SubscriptionRequest } from './subscription-form'
import { SchemaVersionMismatch, withBoss } from './pg-boss.server'

export type SubscriptionResult = { ok: true } | { error: string }

function failure (doing: string, error: unknown): { error: string } {
  if (error instanceof SchemaVersionMismatch) return { error: error.message }
  return { error: `Failed to ${doing}: ${error instanceof Error ? error.message : String(error)}` }
}

/** Subscribes a queue to an event through `boss.subscribe()`. Subscribing it again changes nothing but its updated time. */
export async function subscribeQueue (dbUrl: string, schema: string, { event, queue }: SubscriptionRequest): Promise<SubscriptionResult> {
  try {
    await withBoss(dbUrl, schema, (boss) => boss.subscribe(event, queue))
    return { ok: true }
  } catch (error) {
    return failure('subscribe the queue', error)
  }
}

/** Removes one queue's subscription to an event through `boss.unsubscribe()`. */
export async function unsubscribeQueue (dbUrl: string, schema: string, { event, queue }: SubscriptionRequest): Promise<SubscriptionResult> {
  try {
    await withBoss(dbUrl, schema, (boss) => boss.unsubscribe(event, queue))
    return { ok: true }
  } catch (error) {
    return failure('unsubscribe the queue', error)
  }
}
