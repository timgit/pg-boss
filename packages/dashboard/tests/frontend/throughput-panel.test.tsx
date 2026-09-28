import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import type uPlot from 'uplot'
import { ThroughputPanel, throughputPlugin } from '~/components/throughput-panel'
import type { QueueThroughputPoint } from '~/lib/types'

// uPlot needs a real canvas; the panel's own logic is what is under test here.
vi.mock('~/components/ui/uplot-chart', () => ({
  UplotChart: ({ data }: { data: unknown[][] }) => <div data-testid="uplot" data-columns={data.length} />,
}))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe () {}
    unobserve () {}
    disconnect () {}
  } as unknown as typeof ResizeObserver
})

const point = (bucketStart: number, rates: Partial<QueueThroughputPoint> = {}): QueueThroughputPoint => ({
  bucketStart,
  arrivedPerMin: null,
  completedPerMin: null,
  failedPerMin: null,
  readyCount: null,
  ...rates,
})

describe('ThroughputPanel', () => {
  it('draws the chart with its legend once something has been counted', () => {
    render(<ThroughputPanel title="Throughput" queue="q" range={[0, 120]} noun="hour" points={[point(0, { arrivedPerMin: 3 }), point(60, { completedPerMin: 2 })]} />)

    expect(screen.getByRole('region', { name: 'Throughput' })).toBeTruthy()
    expect(screen.getByText('Arrived /min')).toBeTruthy()
    expect(screen.getByText('Finishing /min')).toBeTruthy()
    expect(screen.getByText('Failed /min')).toBeTruthy()
    expect(screen.getByText('Previous hour')).toBeTruthy()
    expect(screen.getByTestId('uplot').dataset.columns).toBe('4')
  })

  it('says so instead of drawing an empty chart', () => {
    render(<ThroughputPanel title="Throughput" queue="q" range={[0, 120]} noun="hour" points={[point(0), point(60)]} />)

    expect(screen.queryByTestId('uplot')).toBeNull()
    expect(screen.getByText('No throughput counted in this range.')).toBeTruthy()
  })
})

describe('throughputPlugin', () => {
  const colors = {
    arrived: 'A', finishing: 'F', failed: 'X', ahead: 'AHEAD', behind: 'BEHIND', previous: 'PREV', grid: 'G', text: 'T',
  }

  function drawWith (arrived: Array<number | null>, finishing: Array<number | null>) {
    const fills: string[] = []
    const ctx = {
      fillStyle: '',
      save () {}, restore () {}, beginPath () {}, rect () {}, clip () {}, moveTo () {}, lineTo () {}, closePath () {},
      fillRect () { fills.push(`rect:${this.fillStyle}`) },
      fill () { fills.push(this.fillStyle) },
    }
    const u = {
      ctx,
      bbox: { left: 0, top: 0, width: 100, height: 50 },
      data: [arrived.map((_, i) => i * 60), arrived.map(() => null), finishing, arrived],
      valToPos: (v: number) => v,
    } as unknown as uPlot
    throughputPlugin(colors, () => {}).hooks.drawClear!(u as never)
    return fills
  }

  it('shades the previous half, then each gap by which side leads', () => {
    expect(drawWith([5, 5, 1, 1], [1, 1, 5, 5])).toEqual(['rect:PREV', 'AHEAD', 'BEHIND', 'BEHIND'])
  })

  it('leaves a gap unshaded where either side has no value', () => {
    expect(drawWith([5, null, 5, 5], [1, 1, 1, 1])).toEqual(['rect:PREV', 'AHEAD'])
  })
})
