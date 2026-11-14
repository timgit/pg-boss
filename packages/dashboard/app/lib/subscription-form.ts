/**
 * The subscription form, read into the event and queue `boss.subscribe()` and `boss.unsubscribe()`
 * take. Pure, so the rules are testable without a router or a database.
 */

export interface SubscriptionRequest { event: string, queue: string }

export type ParsedSubscription = { error: string } | { value: SubscriptionRequest }

function field (form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export function parseSubscriptionForm (form: FormData): ParsedSubscription {
  const event = field(form, 'event')
  if (!event) return { error: 'An event name is required' }

  const queue = field(form, 'queueName')
  if (!queue) return { error: 'Queue name is required' }

  return { value: { event, queue } }
}
