import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AppSidebar } from '~/components/sidebar'
import { ThemeProvider } from '~/components/theme-provider'
import { SidebarProvider } from '~/components/ui/sidebar'

function renderWithRouter (initialRoute = '/') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <ThemeProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </ThemeProvider>
    </MemoryRouter>
  )
}

describe('Sidebar', () => {
  describe('navigation', () => {
    it('renders navigation links', () => {
      renderWithRouter()

      expect(screen.getByText('Overview')).toBeInTheDocument()
      expect(screen.getByText('Jobs')).toBeInTheDocument()
      expect(screen.getByText('Queues')).toBeInTheDocument()
      expect(screen.getByText('Schedules')).toBeInTheDocument()
      expect(screen.getByText('Migrations')).toBeInTheDocument()
      expect(screen.getByText('Warnings')).toBeInTheDocument()
    })

    it('has correct hrefs for navigation links', () => {
      renderWithRouter()

      const links = screen.getAllByRole('link')
      const hrefs = links.map((link) => link.getAttribute('href'))

      expect(hrefs).toContain('/')
      expect(hrefs).toContain('/jobs')
      expect(hrefs).toContain('/queues')
      expect(hrefs).toContain('/schedules')
      expect(hrefs).toContain('/migrations')
      expect(hrefs).toContain('/warnings')
    })

    it('renders icons for all navigation items', () => {
      const { container } = renderWithRouter()

      // Each nav item should have an SVG icon
      const navLinks = screen.getAllByRole('link')
      const iconsInNav = navLinks.filter(link =>
        link.querySelector('svg')
      )
      expect(iconsInNav.length).toBeGreaterThanOrEqual(5)
    })

    it('renders navigation items for queues route', () => {
      renderWithRouter('/queues')
      expect(screen.getByText('Queues')).toBeInTheDocument()
    })
  })

  describe('branding', () => {
    it('renders pg-boss branding', () => {
      renderWithRouter()

      const brandTexts = screen.getAllByText('pg-boss')
      expect(brandTexts.length).toBeGreaterThanOrEqual(1)
    })

    /**
     * The mark is inlined rather than referenced by URL, so the build stays
     * portable across base paths. It is decorative: the wordmark beside it
     * already says "pg-boss", so `aria-hidden` is the assertion rather than an
     * oversight — announcing the name twice is worse than not announcing the
     * glyph.
     */
    it('renders the mark beside the wordmark', () => {
      const { container } = renderWithRouter()

      const mark = container.querySelector('[aria-hidden="true"] > svg')
      expect(mark).not.toBeNull()

      // The queue row: three jobs, two waiting and the rightmost active. The
      // count is asserted, not the opacity — how faint a waiting job looks is a
      // design decision that has already changed once, and pinning the value
      // makes a test fail for a reason nobody would call a regression. That
      // there are two of them, dimmed, and one that is not, is the mark.
      const dimmed = [...(mark?.querySelectorAll('path[opacity]') ?? [])]
      expect(dimmed).toHaveLength(2)

      for (const job of dimmed) {
        const value = Number(job.getAttribute('opacity'))
        expect(value).toBeGreaterThan(0)
        expect(value).toBeLessThan(1)
      }
    })
  })

  describe('theme toggle', () => {
    it('renders theme toggle button', () => {
      renderWithRouter()

      expect(screen.getAllByLabelText('Toggle theme').length).toBeGreaterThanOrEqual(1)
    })
  })
})
