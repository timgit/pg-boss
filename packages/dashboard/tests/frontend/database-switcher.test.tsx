import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate, useRouteLoaderData, useSearchParams } from 'react-router'
import { DatabaseSwitcher } from '~/components/database-switcher'
import type { PublicDatabase } from '~/lib/types'

const main = { id: 'pgboss', name: 'pgboss', schema: 'pgboss_dev' } as PublicDatabase
const reporting = { id: 'reporting', name: 'reporting', schema: 'pgboss_reporting_dev' } as PublicDatabase
const own = { id: 'pro_queues', name: 'Pro queues', schema: 'pgboss_pro_queue', badge: 'Pro' } as PublicDatabase

// The setup file mocks the router hooks that need a data router; each test says what they return.
function renderAt (path: string, search: string, databases: PublicDatabase[], currentDb: PublicDatabase, pattern = path, internal: PublicDatabase[] = []) {
  const navigate = vi.fn()
  vi.mocked(useRouteLoaderData).mockReturnValue({ databases, internal, currentDb })
  vi.mocked(useSearchParams).mockReturnValue([new URLSearchParams(search), vi.fn()])
  vi.mocked(useNavigate).mockReturnValue(navigate)
  render(
    <MemoryRouter initialEntries={[`${path}${search}`]}>
      <Routes><Route path={pattern} element={<DatabaseSwitcher />} /></Routes>
    </MemoryRouter>
  )
  return navigate
}

describe('DatabaseSwitcher', () => {
  it('names the only database without offering a menu', () => {
    renderAt('/queues', '', [main], main)

    expect(screen.getByText('pgboss')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('names the current database on a menu button when there are several', () => {
    renderAt('/queues', '?schema=reporting', [main, reporting], reporting)

    expect(screen.getByRole('button', { name: 'Schema: reporting. Switch schema' })).toBeInTheDocument()
  })

  it('switches database on the same list page, keeping its other parameters', async () => {
    const navigate = renderAt('/jobs', '?state=failed', [main, reporting], main)

    fireEvent.click(screen.getByRole('button', { name: /Switch schema/ }))
    fireEvent.click(await screen.findByText('pgboss_reporting_dev'))

    expect(navigate).toHaveBeenCalledWith({ pathname: '/jobs', search: '?state=failed&schema=reporting' })
  })

  it('leaves a page about one item for its list, since the other database may not have it', async () => {
    const navigate = renderAt('/queues/emails/jobs/0b1c', '?tab=output', [main, reporting], main, '/queues/:name/jobs/:jobId')

    fireEvent.click(screen.getByRole('button', { name: /Switch schema/ }))
    fireEvent.click(await screen.findByText('pgboss_reporting_dev'))

    expect(navigate).toHaveBeenCalledWith({ pathname: '/queues', search: '?schema=reporting' })
  })

  it('names the first database too when switching back, so a remembered cookie cannot win', async () => {
    const navigate = renderAt('/queues', '?schema=reporting', [main, reporting], reporting)

    fireEvent.click(screen.getByRole('button', { name: /Switch schema/ }))
    fireEvent.click(await screen.findByText('pgboss_dev'))

    expect(navigate).toHaveBeenCalledWith({ pathname: '/queues', search: '?schema=pgboss' })
  })

  it('lists an overlay\'s own schema under Internal, apart from the configured databases', async () => {
    const navigate = renderAt('/queues', '', [main], main, '/queues', [own])

    fireEvent.click(screen.getByRole('button', { name: /Switch schema/ }))

    expect(await screen.findByText('Internal')).toBeInTheDocument()
    expect(screen.getByText('Pro')).toBeInTheDocument()

    fireEvent.click(screen.getByText('pgboss_pro_queue'))

    expect(navigate).toHaveBeenCalledWith({ pathname: '/queues', search: '?schema=pro_queues' })
  })

  it('names an internal schema on the button, with its badge, when it is the one in view', () => {
    renderAt('/queues', '?schema=pro_queues', [main], own, '/queues', [own])

    const button = screen.getByRole('button', { name: 'Schema: Pro queues. Switch schema' })

    expect(button).toHaveTextContent('Pro queues')
    expect(button).toHaveTextContent('Pro')
  })

  it('shows no Internal section when the overlay keeps no schema of its own', async () => {
    renderAt('/queues', '', [main, reporting], main)

    fireEvent.click(screen.getByRole('button', { name: /Switch schema/ }))

    await screen.findByText('pgboss_reporting_dev')
    expect(screen.queryByText('Internal')).not.toBeInTheDocument()
  })
})
