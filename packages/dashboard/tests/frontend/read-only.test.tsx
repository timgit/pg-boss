import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useRouteLoaderData } from 'react-router'
import { useReadOnly } from '~/lib/read-only'
import { ReadOnlyNotice } from '~/components/read-only-notice'

// `useRouteLoaderData` is mocked globally in tests/setup.ts so components that read
// the root loader can render without a data router. Steer that mock per case.
function withRootData (data: unknown) {
  vi.mocked(useRouteLoaderData).mockReturnValue(data)
}

function Probe () {
  return <span data-testid="probe">{String(useReadOnly())}</span>
}

describe('useReadOnly', () => {
  afterEach(() => {
    vi.mocked(useRouteLoaderData).mockReset()
  })

  it('is true when the root loader says so', () => {
    withRootData({ readOnly: true })
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('true')
  })

  it('is false when the root loader says so', () => {
    withRootData({ readOnly: false })
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })

  it('fails closed to writable when the field is absent, since the server enforces anyway', () => {
    withRootData({})
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })

  it('tolerates the root loader data being unavailable', () => {
    withRootData(undefined)
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })

  it('treats a non-boolean value as not read-only rather than coercing it', () => {
    withRootData({ readOnly: 'yes' })
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })
})

describe('ReadOnlyNotice', () => {
  it('names the variable that has to be unset to restore writes', () => {
    render(<ReadOnlyNotice action="Sending jobs" />)

    expect(screen.getByText('This dashboard is read-only')).toBeInTheDocument()
    expect(screen.getByText('PGBOSS_DASHBOARD_READ_ONLY=1')).toBeInTheDocument()
    expect(screen.getByText(/Sending jobs is disabled/)).toBeInTheDocument()
  })
})
