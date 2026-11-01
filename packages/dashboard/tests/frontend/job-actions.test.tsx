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

  it('offers resume on a canceled job', () => {
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

  it('offers nothing on a completed job, and never delete', () => {
    const { container } = renderFor('completed')
    expect(container.textContent).toBe('')

    renderFor('failed')
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
  })
})
