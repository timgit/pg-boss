import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryTimeoutBanner } from '~/components/query-timeout-banner'

describe('QueryTimeoutBanner', () => {
  it('renders an alert with the timeout in seconds', () => {
    render(<QueryTimeoutBanner timeoutMs={60000} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Query timed out')
    expect(alert).toHaveTextContent('exceeded the 60s query limit')
    expect(alert).toHaveTextContent(/narrowing your filters/i)
  })

  it('reflects a custom timeout value', () => {
    render(<QueryTimeoutBanner timeoutMs={5000} />)

    expect(screen.getByRole('alert')).toHaveTextContent('exceeded the 5s query limit')
  })
})
