import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createRoutesStub } from 'react-router'
import { JobActions } from '~/components/job-actions'

function renderFor (state: string) {
  const Stub = createRoutesStub([
    { path: '/', Component: () => <JobActions id="0b9c1f5e-0000-4000-8000-000000000000" state={state} /> },
  ])
  return render(<Stub />)
}

describe('JobActions', () => {
  it('offers retry on a failed job', () => {
    renderFor('failed')
    expect(screen.getByRole('button', { name: /Retry job/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel job/ })).toBeNull()
  })

  it('offers resume on a cancelled job', () => {
    renderFor('cancelled')
    expect(screen.getByRole('button', { name: /Resume job/ })).toBeTruthy()
  })

  it('offers cancel on a job that has not finished', () => {
    for (const state of ['created', 'retry', 'active']) {
      const { unmount } = renderFor(state)
      expect(screen.getByRole('button', { name: /Cancel job/ })).toBeTruthy()
      unmount()
    }
  })

  it('offers delete on every job that isn\'t running', () => {
    for (const state of ['created', 'retry', 'completed', 'cancelled', 'failed']) {
      const { unmount } = renderFor(state)
      expect(screen.getByRole('button', { name: /Delete/ })).toBeTruthy()
      unmount()
    }
  })

  it('offers no delete on an active job, which a worker still holds', () => {
    renderFor('active')
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
  })

  it('offers only delete on a completed job', () => {
    renderFor('completed')
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Delete'])
  })
})
