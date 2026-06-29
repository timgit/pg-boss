import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatsDisabledBanner } from '~/components/stats-disabled-banner'

describe('StatsDisabledBanner', () => {
  it('explains that history is off and how to enable it', () => {
    render(<StatsDisabledBanner />)
    expect(screen.getByText(/history isn.t being recorded/i)).toBeInTheDocument()
    expect(screen.getByText('persistQueueStats: true')).toBeInTheDocument()
  })

  it('forwards a custom className', () => {
    const { container } = render(<StatsDisabledBanner className="mt-8" />)
    expect(container.firstChild).toHaveClass('mt-8')
  })
})
