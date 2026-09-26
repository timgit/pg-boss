import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

// The `~pro` alias is decided once at config load and cannot vary per test, so
// every case here pins the overlay it means to exercise rather than relying on
// what the alias happens to resolve to. That matters in both directions: an
// ordinary build resolves it to the stub, but this suite is also run with a Pro
// overlay mounted (see pgboss-pro's `npm run build -- --test`), where an
// unmocked `~pro` is a real overlay with real nav entries and slots.
function mockOverlay (overlay: unknown) {
  vi.doMock('~pro', () => ({ default: overlay, overlay }))
  vi.resetModules()
}

/** What `~pro` resolves to in a build with no overlay. */
const NO_OVERLAY = { nav: [], slots: {} }

function DemoIcon ({ className }: { className?: string }) {
  return <svg className={className} data-testid="demo-icon" />
}

function DemoFooter () {
  return <div data-testid="pro-footer">overlay footer</div>
}

function DemoTrail () {
  return <nav data-testid="pro-trail">overlay trail</nav>
}

function DemoAccount () {
  return <button type="button" data-testid="pro-account">overlay account</button>
}

async function renderSidebar () {
  // Import the providers from the same module graph as the sidebar: after
  // `vi.resetModules()` a statically imported provider would carry a different
  // React context than the freshly imported consumer.
  const { AppSidebar } = await import('~/components/sidebar')
  const { ThemeProvider } = await import('~/components/theme-provider')
  const { SidebarProvider } = await import('~/components/ui/sidebar')

  return render(
    <MemoryRouter initialEntries={['/']}>
      <ThemeProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ThemeProvider>
    </MemoryRouter>
  )
}

describe('pro overlay', () => {
  afterEach(() => {
    vi.doUnmock('~pro')
    vi.resetModules()
    vi.restoreAllMocks()
  })

  describe('with no overlay', () => {
    it('renders nothing for a slot', async () => {
      mockOverlay(NO_OVERLAY)

      const { ProSlot } = await import('~/components/pro-slot')
      const { container } = render(<ProSlot name="sidebarFooter" />)

      expect(container).toBeEmptyDOMElement()
    })

    it('leaves the free navigation untouched', async () => {
      mockOverlay(NO_OVERLAY)

      await renderSidebar()

      expect(screen.getByText('Overview')).toBeInTheDocument()
      expect(screen.getByText('Warnings')).toBeInTheDocument()
      expect(screen.queryByText('Demo')).not.toBeInTheDocument()
      expect(screen.queryByTestId('pro-footer')).not.toBeInTheDocument()
    })
  })

  describe('with an overlay', () => {
    it('renders a slot the overlay fills', async () => {
      mockOverlay({ nav: [], slots: { sidebarFooter: DemoFooter } })

      const { ProSlot } = await import('~/components/pro-slot')
      render(<ProSlot name="sidebarFooter" />)

      expect(screen.getByTestId('pro-footer')).toBeInTheDocument()
    })

    it('renders the topbar slot the overlay fills', async () => {
      mockOverlay({ nav: [], slots: { topbarStart: DemoTrail } })

      const { ProSlot } = await import('~/components/pro-slot')
      render(<ProSlot name="topbarStart" />)

      expect(screen.getByTestId('pro-trail')).toBeInTheDocument()
    })

    // Every slot is independent: an overlay that fills one and not the other
    // gets exactly what it asked for, which is what lets a slot be added to
    // this contract without touching an overlay already shipped against it.
    it('renders nothing for the topbar slot when only the footer is filled', async () => {
      mockOverlay({ nav: [], slots: { sidebarFooter: DemoFooter } })

      const { ProSlot } = await import('~/components/pro-slot')
      const { container } = render(<ProSlot name="topbarStart" />)

      expect(container).toBeEmptyDOMElement()
    })

    it('renders the topbar end slot the overlay fills', async () => {
      mockOverlay({ nav: [], slots: { topbarEnd: DemoAccount } })

      const { ProSlot } = await import('~/components/pro-slot')
      render(<ProSlot name="topbarEnd" />)

      expect(screen.getByTestId('pro-account')).toBeInTheDocument()
    })

    it('renders nothing for the topbar end slot when only the start is filled', async () => {
      mockOverlay({ nav: [], slots: { topbarStart: DemoTrail } })

      const { ProSlot } = await import('~/components/pro-slot')
      const { container } = render(<ProSlot name="topbarEnd" />)

      expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing for a slot the overlay leaves empty', async () => {
      mockOverlay({ nav: [], slots: {} })

      const { ProSlot } = await import('~/components/pro-slot')
      const { container } = render(<ProSlot name="sidebarFooter" />)

      expect(container).toBeEmptyDOMElement()
    })

    it('appends overlay entries after the free navigation', async () => {
      mockOverlay({
        nav: [{ name: 'Demo', href: '/pro-demo', icon: DemoIcon }],
        slots: { sidebarFooter: DemoFooter },
      })

      await renderSidebar()

      const links = screen.getAllByRole('link').map((link) => link.textContent)
      expect(links).toContain('Overview')
      expect(links[links.length - 1]).toBe('Demo')

      expect(screen.getByRole('link', { name: 'Demo' })).toHaveAttribute('href', '/pro-demo')
      expect(screen.getByTestId('pro-footer')).toBeInTheDocument()
    })
  })
})
