import { describe, it, expect } from 'vitest'
import { ctx, getBoss, createTestQueue, makeContext } from './helpers'
import { action as subscribeAction, loader as subscribeLoader } from '~/routes/subscribe'
import { action as eventAction } from '~/routes/subscriptions.$event'
import { parseSubscriptionForm } from '~/lib/subscription-form'
import { getSubscription } from '~/lib/queries.server'

function form (fields: Record<string, string>) {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) body.set(name, value)
  return body
}

async function subscribe (fields: Record<string, string>, search = '') {
  return subscribeAction({
    params: {},
    context: makeContext(ctx),
    request: new Request(`http://localhost/subscribe${search}`, { method: 'POST', body: form(fields) }),
  } as Parameters<typeof subscribeAction>[0])
}

async function unsubscribe (event: string, fields: Record<string, string>, search = '') {
  return eventAction({
    params: { event },
    context: makeContext(ctx),
    request: new Request(`http://localhost/subscriptions/${encodeURIComponent(event)}${search}`, { method: 'POST', body: form(fields) }),
  } as Parameters<typeof eventAction>[0])
}

async function subscribedQueues (event: string) {
  return (await getSubscription(ctx.connectionString, ctx.schema, event)).map((queue) => queue.name)
}

describe('the subscription form', () => {
  it('needs an event and a queue, trimmed', () => {
    expect(parseSubscriptionForm(form({}))).toEqual({ error: 'An event name is required' })
    expect(parseSubscriptionForm(form({ event: 'user.created' }))).toEqual({ error: 'Queue name is required' })
    expect(parseSubscriptionForm(form({ event: ' user.created ', queueName: ' q ' }))).toEqual({ value: { event: 'user.created', queue: 'q' } })
  })
})

describe('subscribing and unsubscribing a queue', () => {
  it('subscribes the queue and goes on to the event\'s page, keeping the schema in the link', async () => {
    await createTestQueue('test-queue')

    const result = await subscribe({ event: 'user.created', queueName: 'test-queue' }, '?schema=reporting')

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).headers.get('location')).toBe('/subscriptions/user.created?schema=reporting')
    expect(await subscribedQueues('user.created')).toEqual(['test-queue'])
  })

  it('says why when the queue doesn\'t exist', async () => {
    expect(await subscribe({ event: 'user.created', queueName: 'no-such-queue' })).toEqual({ error: expect.stringMatching(/^Failed to subscribe the queue: /) })
  })

  it('unsubscribes the queue it names and stays on the event\'s page while other queues remain', async () => {
    await createTestQueue('test-queue')
    await createTestQueue('other-queue')
    await getBoss().subscribe('user.created', 'test-queue')
    await getBoss().subscribe('user.created', 'other-queue')

    expect(await unsubscribe('user.created', { intent: 'unsubscribe', queue: 'test-queue' })).toEqual({ ok: true })
    expect(await subscribedQueues('user.created')).toEqual(['other-queue'])
  })

  it('goes back to Subscriptions once the last queue is unsubscribed', async () => {
    await createTestQueue('test-queue')
    await getBoss().subscribe('user.created', 'test-queue')

    const result = await unsubscribe('user.created', { intent: 'unsubscribe', queue: 'test-queue' }, '?schema=reporting')

    expect((result as Response).headers.get('location')).toBe('/subscriptions?schema=reporting')
    expect(await subscribedQueues('user.created')).toEqual([])
  })

  it('refuses any other intent, or no queue', async () => {
    expect(await unsubscribe('user.created', { intent: 'drop', queue: 'test-queue' })).toEqual({ error: 'Unknown action' })
    expect(await unsubscribe('user.created', { intent: 'unsubscribe' })).toEqual({ error: 'Unknown action' })
  })

  it('shows the form unless the dashboard is read-only', () => {
    const original = process.env.PGBOSS_DASHBOARD_READ_ONLY
    try {
      delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      expect(subscribeLoader()).toEqual({ readOnly: null })

      process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'
      expect(subscribeLoader().readOnly).toMatch(/read-only/)
    } finally {
      if (original === undefined) delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      else process.env.PGBOSS_DASHBOARD_READ_ONLY = original
    }
  })
})
