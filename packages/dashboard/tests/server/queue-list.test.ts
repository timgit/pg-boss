import { describe, it, expect } from 'vitest'
import { ctx, createTestQueue, updateQueueStats } from './helpers'
import { loadQueueList } from '~/lib/queue-list.server'

function load (search = '', cookie?: string) {
  const request = new Request(`http://localhost/queues${search}`, cookie ? { headers: { cookie } } : undefined)
  return loadQueueList(ctx.connectionString, ctx.schema, request)
}

describe('loadQueueList', () => {
  it('opens on cards, or on the view the URL or the viewer\'s cookie names', async () => {
    expect((await load()).view).toBe('cards')
    expect((await load('', 'other=1; pgboss-queues-view=table')).view).toBe('table')
    expect((await load('?view=cards', 'pgboss-queues-view=table')).view).toBe('cards')
    expect((await load('?view=sideways')).view).toBe('cards')
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
