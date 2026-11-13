import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Pinned per case, as in pro-overlay.test.tsx: the suite also runs with a Pro overlay mounted.
function mockOverlay (overlay: unknown) {
  vi.doMock('~pro', () => ({ default: overlay, overlay }))
  vi.resetModules()
}

const NO_OVERLAY = { nav: [], slots: {} }

function DemoPageActions ({ page }: { page: string }) {
  return <span data-testid="pro-page-actions">{page}</span>
}

// tests/setup.ts replaces useRouteLoaderData and useSearchParams with mocks. Each case says what the
// root loader and the URL hold, on the module graph the component is imported from.
async function renderWith (element: (components: typeof import('~/components/send-job-button')) => React.ReactElement, { readOnly = false, search = '' } = {}) {
  const router = await import('react-router')
  vi.mocked(router.useRouteLoaderData).mockReturnValue({ readOnly })
  vi.mocked(router.useSearchParams).mockReturnValue([new URLSearchParams(search), vi.fn()])

  const components = await import('~/components/send-job-button')
  render(<router.MemoryRouter><div data-testid="header">{element(components)}</div></router.MemoryRouter>)
}

describe('Send job', () => {
  afterEach(() => {
    vi.doUnmock('~pro')
    vi.resetModules()
  })

  it('opens the send form from a page header in a build with no overlay', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ PageActions }) => <PageActions page="overview" />)

    expect(screen.getByRole('link', { name: 'Send job' }).getAttribute('href')).toBe('/send')
  })

  it('starts on the queue it is given, and keeps the schema', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ SendJobButton }) => <SendJobButton queue="billing" />, { search: 'schema=reporting' })

    expect(screen.getByRole('link', { name: 'Send job' }).getAttribute('href')).toBe('/send?queue=billing&schema=reporting')
  })

  it('is left out in read-only mode', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ PageActions }) => <PageActions page="jobs" />, { readOnly: true })

    expect(screen.getByTestId('header')).toBeEmptyDOMElement()
  })

  it('gives way to the overlay\'s page actions', async () => {
    mockOverlay({ nav: [], slots: { pageActions: DemoPageActions } })
    await renderWith(({ PageActions }) => <PageActions page="jobs" />)

    expect(screen.getByTestId('pro-page-actions').textContent).toBe('jobs')
    expect(screen.queryByRole('link', { name: 'Send job' })).toBeNull()
  })
})
