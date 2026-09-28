import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

function DemoQueueActions ({ queue }: { queue: { name: string, isDeadLetter: boolean } }) {
  return <span data-testid="pro-queue-actions">{queue.name}{queue.isDeadLetter ? ' (dead letter)' : ''}</span>
}

function DemoJobActions ({ job }: { job: { id: string, name: string, state: string } }) {
  return <span data-testid="pro-job-actions">{job.name}/{job.id} {job.state}</span>
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

    it('fills no slot, so the free build draws no write controls', async () => {
      mockOverlay(NO_OVERLAY)

      const { hasProSlot } = await import('~/components/pro-slot')

      for (const name of ['pageActions', 'queueActions', 'jobActions', 'jobRowActions', 'scheduleActions'] as const) {
        expect(hasProSlot(name)).toBe(false)
      }
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

    // The one slot with props: the queue page says which queue it is showing,
    // so the overlay can decide what to offer without asking the server.
    it('hands the queue actions slot the queue on screen', async () => {
      mockOverlay({ nav: [], slots: { queueActions: DemoQueueActions } })

      const { ProSlot } = await import('~/components/pro-slot')
      render(<ProSlot name="queueActions" queue={{ name: 'email-dlq', isDeadLetter: true }} />)

      expect(screen.getByTestId('pro-queue-actions')).toHaveTextContent('email-dlq (dead letter)')
    })

    it('renders nothing for the queue actions slot when the overlay does not fill it', async () => {
      mockOverlay({ nav: [], slots: { topbarEnd: DemoAccount } })

      const { ProSlot } = await import('~/components/pro-slot')
      const { container } = render(<ProSlot name="queueActions" queue={{ name: 'email', isDeadLetter: false }} />)

      expect(container).toBeEmptyDOMElement()
    })

    // The free build has no actions of its own, so every write control arrives through a slot.
    it('hands the job action slots the job, its queue and its state', async () => {
      mockOverlay({ nav: [], slots: { jobActions: DemoJobActions, jobRowActions: DemoJobActions } })

      const { ProSlot } = await import('~/components/pro-slot')
      render(<ProSlot name="jobRowActions" job={{ id: 'j1', name: 'emails', state: 'failed' }} />)

      expect(screen.getByTestId('pro-job-actions')).toHaveTextContent('emails/j1 failed')
    })

    it('says which slots an overlay fills, so a page can leave out a column it would leave empty', async () => {
      mockOverlay({ nav: [], slots: { jobActions: DemoJobActions } })

      const { hasProSlot } = await import('~/components/pro-slot')

      expect(hasProSlot('jobActions')).toBe(true)
      expect(hasProSlot('jobRowActions')).toBe(false)
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

  // The /stats slots, as the fixture overlay fills them.
  describe('on /stats', () => {
    const point = { bucketStart: 0, arrivedPerMin: 1, completedPerMin: 1, failedPerMin: 0, readyCount: 0 }
    const tile = (name: string, arrivedPerMin: number) => ({
      name,
      interval: '1h' as const,
      bucketSeconds: 180,
      arrivedPerMin,
      finishingPerMin: arrivedPerMin,
      share: 0.1,
      points: [point, point],
    })

    async function renderTiles () {
      const { StatsTileGrid } = await import('~/components/stats-tiles')
      return render(
        <MemoryRouter>
          <StatsTileGrid tiles={[tile('busy', 50), tile('meh-q', 20), tile('bad-q', 5)]} interval="1h" noun="hour" />
        </MemoryRouter>
      )
    }

    const tileNames = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'))

    it('hands the KPI slots the series the page loaded', async () => {
      const { overlay } = await import('../fixtures/pro-overlay')
      mockOverlay(overlay)

      const { ProSlot } = await import('~/components/pro-slot')
      render(
        <>
          <ProSlot name="statsQueueKpi" queue={{ name: 'emails', interval: '6h', bucketSeconds: 300, points: [point, point] }} />
          <ProSlot name="statsOverviewKpi" queues={[tile('a', 1), tile('b', 2)]} />
        </>
      )

      expect(screen.getByTestId('pro-stats-queue-kpi')).toHaveTextContent('emails 6h 2 points')
      expect(screen.getByTestId('pro-stats-overview-kpi')).toHaveTextContent('a,b')
    })

    it('badges and borders each tile, and orders them worst first by default', async () => {
      const { overlay } = await import('../fixtures/pro-overlay')
      mockOverlay(overlay)

      await renderTiles()

      expect(tileNames()).toEqual(['/stats/bad-q?interval=1h', '/stats/meh-q?interval=1h', '/stats/busy?interval=1h'])
      expect(screen.getAllByTestId('pro-stats-tile-badge').map((b) => b.textContent)).toEqual(['critical', 'watch', 'ok'])
      const [bad, meh, busy] = screen.getAllByRole('link')
      expect(bad.className).toContain('border-[var(--error-500)]')
      expect(meh.className).toContain('border-[var(--warning-500)]')
      expect(busy.className).toContain('border-[var(--border-default)]')

      fireEvent.click(screen.getByRole('button', { name: 'Busiest first' }))
      expect(tileNames()).toEqual(['/stats/busy?interval=1h', '/stats/meh-q?interval=1h', '/stats/bad-q?interval=1h'])
    })

    it('leaves the tiles plain and busiest first without an overlay', async () => {
      mockOverlay(NO_OVERLAY)

      await renderTiles()

      expect(tileNames()).toEqual(['/stats/busy?interval=1h', '/stats/meh-q?interval=1h', '/stats/bad-q?interval=1h'])
      expect(screen.queryByTestId('pro-stats-tile-badge')).toBeNull()
      expect(screen.queryByRole('group', { name: 'Sort queues' })).toBeNull()
      expect(screen.getByText('Busiest first')).toBeInTheDocument()
    })

    it('hands the marker row the chart, its time span and where the plot sits', async () => {
      const { overlay } = await import('../fixtures/pro-overlay')
      mockOverlay(overlay)

      const { ProSlot } = await import('~/components/pro-slot')
      render(<ProSlot name="statsChartMarkers" queue={null} chart="throughput" from={0} to={7200} plot={{ left: 48, width: 900 }} />)

      expect(screen.getByTestId('pro-stats-markers')).toHaveTextContent('all throughput 0-7200 at 48+900')
    })
  })
})
