import { describe, it, expect } from 'vitest'
import { ctx, createTestQueue, insertQueueStatsHistory, makeContext } from './helpers'
import { statsWindows } from '~/lib/stats'
import { loader } from '~/routes/stats.$queue'

async function loadStats (queue: string, search = '') {
  return loader({
    params: { queue },
    context: makeContext(ctx),
    request: new Request(`http://localhost/stats/${queue}${search}`),
  } as Parameters<typeof loader>[0])
}

// A pass counted halfway through a window, far enough from either edge that the minute rolling
// over between here and the loader cannot move it into the other window.
const midway = (window: { from: Date, to: Date }) =>
  new Date((window.from.getTime() + window.to.getTime()) / 2)

describe('/stats/:queue loader', () => {
  it('throws a 404 for a queue that does not exist', async () => {
    await expect(loadStats('no-such-queue')).rejects.toMatchObject({ status: 404 })
  })

  it('defaults to 1h: two hours of minute buckets', async () => {
    await createTestQueue('st-default')

    const data = await loadStats('st-default')

    expect(data.interval).toBe('1h')
    expect(data.points).toHaveLength(120)
    expect(data.points[1].bucketStart - data.points[0].bucketStart).toBe(60)
  })

  it('takes the interval from the URL', async () => {
    await createTestQueue('st-6h')

    const data = await loadStats('st-6h', '?interval=6h')

    expect(data.interval).toBe('6h')
    expect(data.points).toHaveLength(144)
  })

  it('averages arrivals and finishing (completed plus failed) for each window', async () => {
    await createTestQueue('st-rates')
    const { previous, current } = statsWindows('1h')
    await insertQueueStatsHistory(ctx.schema, 'st-rates', [
      { capturedOn: midway(previous), readyCount: 1, createdDelta: 100, completedDelta: 90, failedDelta: 10, deltaSeconds: 60 },
      { capturedOn: midway(current), readyCount: 5, createdDelta: 138, completedDelta: 60, failedDelta: 5, deltaSeconds: 60 },
    ])

    const data = await loadStats('st-rates')

    expect(data.statsAvailable).toBe(true)
    expect(data.arrived).toEqual({ current: 138, previous: 100 })
    expect(data.finishing).toEqual({ current: 65, previous: 100 })
  })

  it('reports no rates, and no stats collection, for a queue nothing has counted', async () => {
    await createTestQueue('st-none')

    const data = await loadStats('st-none')

    expect(data.statsAvailable).toBe(false)
    expect(data.arrived).toEqual({ current: null, previous: null })
    expect(data.finishing).toEqual({ current: null, previous: null })
  })
})
