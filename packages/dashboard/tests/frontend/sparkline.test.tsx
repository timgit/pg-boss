import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from '~/components/ui/sparkline'

describe('Sparkline', () => {
  it('renders nothing for an empty series', () => {
    const { container } = render(<Sparkline data={[]} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('draws a polyline with one point per datum for a multi-point series', () => {
    const { container } = render(<Sparkline data={[1, 5, 2, 8]} showDot={false} />)
    const polyline = container.querySelector('polyline')
    expect(polyline).not.toBeNull()
    expect(polyline!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(4)
    expect(container.querySelector('circle')).toBeNull()
  })

  it('renders only the trailing dot for a single point', () => {
    const { container } = render(<Sparkline data={[3]} />)
    expect(container.querySelector('polyline')).toBeNull()
    expect(container.querySelector('circle')).not.toBeNull()
  })

  it('centers a flat series instead of pinning it to the baseline', () => {
    const { container } = render(<Sparkline data={[1, 1, 1]} height={24} showDot={false} />)
    const ys = container.querySelector('polyline')!
      .getAttribute('points')!
      .trim()
      .split(/\s+/)
      .map((point) => Number(point.split(',')[1]))
    expect(new Set(ys)).toEqual(new Set([12]))
  })

  it('stays within a container narrower than its nominal width', () => {
    // jsdom has no layout engine, so the class assertion stands in for measuring the rendered box.
    const { container } = render(<Sparkline data={[1, 2, 3]} width={160} />)
    expect(container.querySelector('svg')!.getAttribute('class')).toContain('max-w-full')
  })

  it('applies the provided color and aria-label', () => {
    const { container } = render(
      <Sparkline data={[1, 2, 3]} color="var(--error-600)" aria-label="trend" />
    )
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-label')).toBe('trend')
    expect(container.querySelector('polyline')!.getAttribute('stroke')).toBe('var(--error-600)')
  })

  it('breaks the line at a gap instead of bridging it', () => {
    const { container } = render(<Sparkline data={[1, 2, null, 4, 5, 6]} showDot={false} />)
    const lines = [...container.querySelectorAll('polyline')].map((p) => p.getAttribute('points')!.trim().split(/\s+/).length)
    expect(lines).toEqual([2, 3])
  })

  it('keeps each value at its own place in time across a gap', () => {
    // The lone 1 before the gap draws no line; the run after it sits at the third and fourth slots.
    const { container } = render(<Sparkline data={[1, null, 2, 3]} width={90} strokeWidth={0} showDot={false} />)
    const xs = container.querySelector('polyline')!.getAttribute('points')!.trim().split(/\s+/).map((p) => Number(p.split(',')[0]))
    expect(xs).toEqual([60, 90])
  })

  it('renders nothing when every value is missing', () => {
    const { container } = render(<Sparkline data={[null, null]} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('leaves off the dot when the latest value is missing', () => {
    const { container } = render(<Sparkline data={[1, 2, null]} />)
    expect(container.querySelector('circle')).toBeNull()
  })

  it('scales from zero when zeroBased', () => {
    const { container } = render(<Sparkline data={[50, 100]} height={20} strokeWidth={0} showDot={false} zeroBased />)
    const ys = container.querySelector('polyline')!.getAttribute('points')!.trim().split(/\s+/).map((p) => Number(p.split(',')[1]))
    expect(ys).toEqual([10, 0])
  })

  it('shades the left part of the plot when asked', () => {
    const { container } = render(<Sparkline data={[1, 2]} width={200} shadeTo={0.5} />)
    expect(container.querySelector('rect')!.getAttribute('width')).toBe('100')
  })
})
