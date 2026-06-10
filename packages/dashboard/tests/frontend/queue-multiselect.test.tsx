import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueueMultiSelect } from '~/components/ui/queue-multiselect'

// The dropdown popup is rendered via base-ui's Portal so it is not present in
// the DOM until the trigger is opened (which the headless test environment
// doesn't fully animate). These tests cover what's reachable: trigger label,
// placeholder, and the props contract.

describe('QueueMultiSelect', () => {
  it('shows the placeholder when no value is selected', () => {
    render(
      <QueueMultiSelect
        options={['alpha', 'beta']}
        value={[]}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('All Queues')).toBeInTheDocument()
  })

  it('shows the queue name when a single value is selected', () => {
    render(
      <QueueMultiSelect
        options={['alpha', 'beta']}
        value={['alpha']}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('alpha')).toBeInTheDocument()
  })

  it('summarises with a count when multiple values are selected', () => {
    render(
      <QueueMultiSelect
        options={['alpha', 'beta', 'gamma']}
        value={['alpha', 'beta']}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('2 queues')).toBeInTheDocument()
  })

  it('honours a custom placeholder', () => {
    render(
      <QueueMultiSelect
        options={[]}
        value={[]}
        onChange={vi.fn()}
        placeholder="Pick one"
      />
    )
    expect(screen.getByText('Pick one')).toBeInTheDocument()
  })
})
