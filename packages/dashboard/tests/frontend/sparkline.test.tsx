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

  it('applies the provided color and aria-label', () => {
    const { container } = render(
      <Sparkline data={[1, 2, 3]} color="var(--error-600)" aria-label="trend" />
    )
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-label')).toBe('trend')
    expect(container.querySelector('polyline')!.getAttribute('stroke')).toBe('var(--error-600)')
  })
})
