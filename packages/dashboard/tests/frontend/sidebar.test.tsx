import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AppSidebar } from '~/components/layout/sidebar'
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
      expect(screen.getByText('Queues')).toBeInTheDocument()
      expect(screen.getByText('Warnings')).toBeInTheDocument()
    })

    it('has correct hrefs for navigation links', () => {
      renderWithRouter()

      const links = screen.getAllByRole('link')
      const hrefs = links.map((link) => link.getAttribute('href'))

      expect(hrefs).toContain('/')
      expect(hrefs).toContain('/queues')
      expect(hrefs).toContain('/warnings')
    })
  })

  describe('branding', () => {
    it('renders pg-boss branding', () => {
      renderWithRouter()

      const brandTexts = screen.getAllByText('pg-boss')
      expect(brandTexts.length).toBeGreaterThanOrEqual(1)
    })

    it('renders PG logo', () => {
      renderWithRouter()

      const logoTexts = screen.getAllByText('PG')
      expect(logoTexts.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('theme toggle', () => {
    it('renders theme toggle button', () => {
      renderWithRouter()

      expect(screen.getAllByLabelText('Toggle theme').length).toBeGreaterThanOrEqual(1)
    })
  })
})
