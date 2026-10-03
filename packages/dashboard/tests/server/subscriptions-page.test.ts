import { describe, it, expect } from 'vitest'
import { ctx, getBoss, makeContext } from './helpers'
import { loader } from '~/routes/subscriptions'
import { loader as queueLoader } from '~/routes/queues.$name'

async function loadSubscriptions (search = '') {
  return loader({
    params: {},
    context: makeContext(ctx),
    request: new Request(`http://localhost/subscriptions${search}`),
  } as Parameters<typeof loader>[0])
}

async function seed () {
  const boss = getBoss()
  for (const name of ['billing', 'email', 'search']) {
    await boss.createQueue(name)
  }
  await boss.subscribe('user.created', 'email')
  await boss.subscribe('user.created', 'billing')
  await boss.subscribe('user.created', 'search')
  await boss.subscribe('order.placed', 'billing')
  await boss.subscribe('page.edited', 'search')
}

describe('/subscriptions loader', () => {
  it('lists nothing when nothing is subscribed', async () => {
    const data = await loadSubscriptions()

    expect(data.subscriptions).toEqual([])
    expect(data.totalCount).toBe(0)
  })

  it('lists one row per event with its queues in name order', async () => {
    await seed()

    const data = await loadSubscriptions()

    expect(data.totalCount).toBe(3)
    expect(data.subscriptions.map((s) => [s.event, s.queues])).toEqual([
      ['order.placed', ['billing']],
      ['page.edited', ['search']],
      ['user.created', ['billing', 'email', 'search']],
    ])
    expect(data.subscriptions[0].updatedOn).toBeInstanceOf(Date)
  })

  it('sorts by queue count', async () => {
    await seed()

    const data = await loadSubscriptions('?sort=queues&dir=desc')

    expect(data.subscriptions.map((s) => s.event)).toEqual(['user.created', 'order.placed', 'page.edited'])
  })

  it('filters to the events one queue is subscribed to, still listing every queue on them', async () => {
    await seed()

    const data = await loadSubscriptions('?queue=billing')

    expect(data.queue).toBe('billing')
    expect(data.totalCount).toBe(2)
    expect(data.subscriptions.map((s) => [s.event, s.queues])).toEqual([
      ['order.placed', ['billing']],
      ['user.created', ['billing', 'email', 'search']],
    ])
  })

  it('drops a queue from its events when the queue is deleted', async () => {
    await seed()
    await getBoss().deleteQueue('search')

    const data = await loadSubscriptions()

    expect(data.subscriptions.map((s) => [s.event, s.queues])).toEqual([
      ['order.placed', ['billing']],
      ['user.created', ['billing', 'email']],
    ])
  })

  it('pages by event', async () => {
    const boss = getBoss()
    await boss.createQueue('fanout')
    for (let i = 0; i < 25; i++) {
      await boss.subscribe(`event-${String(i).padStart(2, '0')}`, 'fanout')
    }

    const first = await loadSubscriptions()
    const second = await loadSubscriptions('?page=2')

    expect(first.subscriptions).toHaveLength(20)
    expect(first.hasNextPage).toBe(true)
    expect(second.subscriptions.map((s) => s.event)).toEqual(['event-20', 'event-21', 'event-22', 'event-23', 'event-24'])
  })
})

describe('queue page', () => {
  it('counts the events the queue is subscribed to', async () => {
    await seed()

    const load = (name: string) => queueLoader({
      params: { name },
      context: makeContext(ctx),
      request: new Request(`http://localhost/queues/${name}`),
    } as Parameters<typeof queueLoader>[0])

    expect((await load('billing')).subscribedEvents).toBe(2)
    expect((await load('email')).subscribedEvents).toBe(1)

    await getBoss().createQueue('quiet')
    expect((await load('quiet')).subscribedEvents).toBe(0)
  })
})
