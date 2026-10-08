import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useNavigate, useRouteLoaderData, useSearchParams } from 'react-router'
import { DatabaseSwitcher } from '~/components/database-switcher'
import type { PublicDatabase } from '~/lib/types'

const main = { id: 'pgboss', name: 'pgboss', schema: 'pgboss_dev' } as PublicDatabase
const reporting = { id: 'reporting', name: 'reporting', schema: 'pgboss_reporting_dev' } as PublicDatabase

// The setup file mocks the router hooks that need a data router; each test says what they return.
function renderAt (path: string, search: string, databases: PublicDatabase[], currentDb: PublicDatabase) {
  const navigate = vi.fn()
  vi.mocked(useRouteLoaderData).mockReturnValue({ databases, currentDb })
  vi.mocked(useSearchParams).mockReturnValue([new URLSearchParams(search), vi.fn()])
  vi.mocked(useNavigate).mockReturnValue(navigate)
  render(<MemoryRouter initialEntries={[`${path}${search}`]}><DatabaseSwitcher /></MemoryRouter>)
  return navigate
}

describe('DatabaseSwitcher', () => {
  it('names the only database without offering a menu', () => {
    renderAt('/queues', '', [main], main)

    expect(screen.getByText('pgboss')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('names the current database on a menu button when there are several', () => {
    renderAt('/queues', '?db=reporting', [main, reporting], reporting)

    expect(screen.getByRole('button', { name: 'Database: reporting. Switch database' })).toBeInTheDocument()
  })

  it('switches database on the same page, keeping its other parameters', async () => {
    const navigate = renderAt('/queues/emails', '?state=failed', [main, reporting], main)

    fireEvent.click(screen.getByRole('button', { name: /Switch database/ }))
    fireEvent.click(await screen.findByText('pgboss_reporting_dev'))

    expect(navigate).toHaveBeenCalledWith({ pathname: '/queues/emails', search: '?state=failed&db=reporting' })
  })

  it('names the first database too when switching back, so a remembered cookie cannot win', async () => {
    const navigate = renderAt('/queues', '?db=reporting', [main, reporting], reporting)

    fireEvent.click(screen.getByRole('button', { name: /Switch database/ }))
    fireEvent.click(await screen.findByText('pgboss_dev'))

    expect(navigate).toHaveBeenCalledWith({ pathname: '/queues', search: '?db=pgboss' })
  })
})
