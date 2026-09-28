import { describe, it, expect } from 'vitest'
import { ctx, createTestQueue, insertQueueStatsHistory, makeContext } from './helpers'
import { statsWindows } from '~/lib/stats'
import { loader } from '~/routes/stats._index'

async function loadStats (search = '') {
  return loader({
    params: {},
    context: makeContext(ctx),
    request: new Request(`http://localhost/stats${search}`),
  } as Parameters<typeof loader>[0])
}

const midway = (window: { from: Date, to: Date }) =>
  new Date((window.from.getTime() + window.to.getTime()) / 2)

describe('/stats loader', () => {
  it('sums every queue into one series and one rate per window', async () => {
    await createTestQueue('all-a')
    await createTestQueue('all-b')
    const { previous, current } = statsWindows('1h')
    await insertQueueStatsHistory(ctx.schema, 'all-a', [
      { capturedOn: midway(previous), readyCount: 1, createdDelta: 60, completedDelta: 60, failedDelta: 0, deltaSeconds: 60 },
      { capturedOn: midway(current), readyCount: 2, createdDelta: 90, completedDelta: 50, failedDelta: 10, deltaSeconds: 60 },
    ])
    await insertQueueStatsHistory(ctx.schema, 'all-b', [
      { capturedOn: midway(current), readyCount: 3, createdDelta: 30, completedDelta: 30, failedDelta: 0, deltaSeconds: 60 },
    ])

    const data = await loadStats()

    expect(data.interval).toBe('1h')
    expect(data.queueCount).toBe(2)
    expect(data.statsAvailable).toBe(true)
    expect(data.points).toHaveLength(120)
    expect(data.arrived).toEqual({ current: 120, previous: 60 })
    expect(data.finishing).toEqual({ current: 90, previous: 60 })
    expect(data.tiles.map((t) => [t.name, t.arrivedPerMin, t.share])).toEqual([['all-a', 90, 0.75], ['all-b', 30, 0.25]])
  })

  it('counts queues with nothing counted, and reports no rate', async () => {
    await createTestQueue('all-quiet')

    const data = await loadStats('?interval=24h')

    expect(data.interval).toBe('24h')
    expect(data.queueCount).toBe(1)
    expect(data.points).toHaveLength(192)
    expect(data.arrived).toEqual({ current: null, previous: null })
    expect(data.tiles).toMatchObject([{ name: 'all-quiet', arrivedPerMin: null, share: null }])
  })
})
