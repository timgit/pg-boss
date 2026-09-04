import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

// `~pro` resolves to the no-op stub in every build of this package, so the
// overlay-present cases mock the module rather than installing a fixture — the
// alias is decided once at config load and cannot vary per test.
function mockOverlay (overlay: unknown) {
  vi.doMock('~pro', () => ({ default: overlay, overlay }))
  vi.resetModules()
}

function DemoIcon ({ className }: { className?: string }) {
  return <svg className={className} data-testid="demo-icon" />
}

function DemoFooter () {
  return <div data-testid="pro-footer">overlay footer</div>
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
      const { ProSlot } = await import('~/components/pro-slot')
      const { container } = render(<ProSlot name="sidebarFooter" />)

      expect(container).toBeEmptyDOMElement()
    })

    it('leaves the free navigation untouched', async () => {
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
