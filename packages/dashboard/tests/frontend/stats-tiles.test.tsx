import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StatsTileGrid, TILE_LIMIT, TileChart } from '~/components/stats-tiles'
import type { StatsQueueSummary } from '~/lib/stats'
import type { QueueThroughputPoint } from '~/lib/types'

const point = (bucketStart: number, rates: Partial<QueueThroughputPoint> = {}): QueueThroughputPoint => ({
  bucketStart,
  arrivedPerMin: null,
  completedPerMin: null,
  failedPerMin: null,
  readyCount: null,
  ...rates,
})

const tile = (name: string, arrivedPerMin: number | null, share: number | null = 0.1): StatsQueueSummary => ({
  name,
  interval: '6h',
  bucketSeconds: 900,
  arrivedPerMin,
  finishingPerMin: arrivedPerMin,
  share,
  points: [point(0, { arrivedPerMin, completedPerMin: arrivedPerMin }), point(60, { arrivedPerMin, completedPerMin: arrivedPerMin })],
})

function renderGrid (tiles: StatsQueueSummary[]) {
  return render(
    <MemoryRouter>
      <StatsTileGrid tiles={tiles} interval="6h" noun="6 hours" />
    </MemoryRouter>
  )
}

const hrefs = () => within(screen.getByRole('region', { name: 'Queues' })).getAllByRole('link').map((a) => a.getAttribute('href'))

describe('StatsTileGrid', () => {
  it('keeps the order it is given, and opens each queue at the same interval', () => {
    renderGrid([tile('busy', 40, 0.8), tile('quiet', 10, 0.2)])

    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/stats/busy?interval=6h', '/stats/quiet?interval=6h'])
    expect(screen.getAllByText('40/min', { selector: 'b' })).toHaveLength(2)
    expect(screen.getByText('80% of arrivals')).toBeTruthy()
  })

  it('shows the first eight until asked for the rest', () => {
    renderGrid(Array.from({ length: 11 }, (_, i) => tile(`q${i}`, 100 - i)))

    expect(screen.getAllByRole('link')).toHaveLength(TILE_LIMIT)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 11 queues' }))
    expect(screen.getAllByRole('link')).toHaveLength(11)
    fireEvent.click(screen.getByRole('button', { name: `Show the first ${TILE_LIMIT}` }))
    expect(screen.getAllByRole('link')).toHaveLength(TILE_LIMIT)
  })

  it('filters by name, and says when nothing matches', () => {
    renderGrid([tile('email-send', 5), tile('email-bounce', 4), tile('billing', 3)])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter queues by name' }), { target: { value: 'EMAIL' } })
    expect(hrefs()).toEqual(['/stats/email-send?interval=6h', '/stats/email-bounce?interval=6h'])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter queues by name' }), { target: { value: 'nope' } })
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.getByText('No queue name contains “nope”.')).toBeTruthy()
  })

  it('shows a dash and no share for a queue nothing has counted', () => {
    renderGrid([tile('idle', null, null)])

    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.queryByText(/of arrivals/)).toBeNull()
  })
})

describe('TileChart', () => {
  it('shades each gap by which side leads, and labels its own scale', () => {
    const { container } = render(
      <TileChart points={[
        point(0, { arrivedPerMin: 30, completedPerMin: 10 }),
        point(60, { arrivedPerMin: 30, completedPerMin: 10 }),
        point(120, { arrivedPerMin: 5, completedPerMin: 30 }),
        point(180, { arrivedPerMin: 5, completedPerMin: 30 }),
      ]}
      />
    )
    const fills = [...container.querySelectorAll('polygon')].map((p) => p.getAttribute('fill'))
    expect(fills).toEqual(['var(--stats-gap-ahead)', 'var(--stats-gap-behind)', 'var(--stats-gap-behind)'])
    expect(screen.getByText('40/min')).toBeTruthy()
  })
})
