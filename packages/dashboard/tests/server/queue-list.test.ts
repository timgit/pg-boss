import { describe, it, expect } from 'vitest'
import { ctx, createTestQueue, updateQueueStats } from './helpers'
import { loadQueueList } from '~/lib/queue-list.server'

function load (search = '', cookie?: string, options?: { views?: string[], defaultView?: string }) {
  const request = new Request(`http://localhost/queues${search}`, cookie ? { headers: { cookie } } : undefined)
  return loadQueueList(ctx.connectionString, ctx.schema, request, options)
}

describe('loadQueueList', () => {
  it('draws a table, whatever the URL or cookie asks, unless an overlay offers cards', async () => {
    expect(await load('?view=cards', 'pgboss-queues-view=cards')).toMatchObject({ views: ['table'], view: 'table' })
  })

  it('with cards on offer, opens on cards, or on the view the URL or the viewer\'s cookie names', async () => {
    const cards = { views: ['table', 'cards'], defaultView: 'cards' }
    expect((await load('', undefined, cards)).view).toBe('cards')
    expect((await load('', 'other=1; pgboss-queues-view=table', cards)).view).toBe('table')
    expect((await load('?view=cards', 'pgboss-queues-view=table', cards)).view).toBe('cards')
    expect((await load('?view=sideways', undefined, cards)).view).toBe('cards')
  })

  it('puts the most ready first unless the URL names a sort', async () => {
    await createTestQueue('test-a')
    await createTestQueue('test-b')
    await updateQueueStats(ctx.schema, 'test-a', { readyCount: 5 })
    await updateQueueStats(ctx.schema, 'test-b', { readyCount: 50 })

    const byDefault = await load()
    expect(byDefault.sort).toBeNull()
    expect(byDefault.queues.map((q) => q.name).filter((n) => n.startsWith('test-'))).toEqual(['test-b', 'test-a'])

    const byName = await load('?sort=name&dir=asc')
    expect(byName.queues.map((q) => q.name).filter((n) => n.startsWith('test-'))).toEqual(['test-a', 'test-b'])
  })
})
