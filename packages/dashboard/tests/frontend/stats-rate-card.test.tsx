import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatsRateCard, formatRate } from '~/components/stats-rate-card'

const base = {
  label: 'Finishing rate',
  color: 'var(--stats-finishing)',
  noun: 'hour',
  series: [1, 2, 3, 4],
} as const

describe('formatRate', () => {
  it('drops decimals as the rate grows', () => {
    expect(formatRate(1234.4)).toBe('1,234')
    expect(formatRate(42.4)).toBe('42')
    expect(formatRate(4.25)).toBe('4.3')
  })
})

describe('StatsRateCard', () => {
  it('shows the current rate per minute and the change against the previous window', () => {
    render(<StatsRateCard {...base} current={138} previous={100} tone="neutral" />)

    expect(screen.getByText('138')).toBeTruthy()
    expect(screen.getByText('+38%')).toBeTruthy()
    expect(screen.getByText('vs previous hour')).toBeTruthy()
  })

  it('colours a fall red and a rise green when higher is better', () => {
    const { rerender } = render(<StatsRateCard {...base} current={65} previous={100} tone="higher-is-better" />)
    expect(screen.getByText('−35%').className).toContain('--error-600')

    rerender(<StatsRateCard {...base} current={130} previous={100} tone="higher-is-better" />)
    expect(screen.getByText('+30%').className).toContain('--success-600')
  })

  it('leaves a change uncoloured when the rate is neutral', () => {
    render(<StatsRateCard {...base} current={65} previous={100} tone="neutral" />)
    expect(screen.getByText('−35%').className).toContain('--text-primary')
  })

  it('reads a change under 3% as flat', () => {
    render(<StatsRateCard {...base} current={101} previous={100} tone="higher-is-better" />)
    expect(screen.getByText('≈ 0%')).toBeTruthy()
  })

  it('words a rise from zero', () => {
    render(<StatsRateCard {...base} current={4} previous={0} tone="neutral" />)
    expect(screen.getByText('up from zero')).toBeTruthy()
  })

  it('says so when there is nothing to compare against', () => {
    render(<StatsRateCard {...base} current={4} previous={null} tone="neutral" />)
    expect(screen.getByText('No rate for the hour before')).toBeTruthy()
  })

  it('shows a dash, and says the current window has no rate, when nothing was counted in it', () => {
    render(<StatsRateCard {...base} current={null} previous={12} tone="neutral" series={[null, null]} />)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText('No rate in the last hour')).toBeTruthy()
  })
})
