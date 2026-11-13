import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Pinned per case, as in send-job-button.test.tsx: the suite also runs with a Pro overlay mounted.
function mockOverlay (overlay: unknown) {
  vi.doMock('~pro', () => ({ default: overlay, overlay }))
  vi.resetModules()
}

const NO_OVERLAY = { nav: [], slots: {} }

function DemoPageActions ({ page }: { page: string }) {
  return <span data-testid="pro-page-actions">{page}</span>
}

function DemoScheduleActions ({ schedule }: { schedule: { name: string, key: string | null } }) {
  return <span data-testid="pro-schedule-actions">{schedule.name}:{schedule.key}</span>
}

// tests/setup.ts replaces useRouteLoaderData and useSearchParams with mocks. Each case says what the
// root loader and the URL hold, on the module graph the component is imported from.
async function renderWith (element: (components: typeof import('~/components/schedule-actions')) => React.ReactElement, { readOnly = false, search = '' } = {}) {
  const router = await import('react-router')
  vi.mocked(router.useRouteLoaderData).mockReturnValue({ readOnly })
  vi.mocked(router.useSearchParams).mockReturnValue([new URLSearchParams(search), vi.fn()])

  const components = await import('~/components/schedule-actions')
  const routes = [{ path: '/', element: <div data-testid="header">{element(components)}</div> }]
  render(<router.RouterProvider router={router.createMemoryRouter(routes)} />)
}

describe('the schedule controls', () => {
  afterEach(() => {
    vi.doUnmock('~pro')
    vi.resetModules()
  })

  it('open the new schedule form from the Schedules page, keeping the schema', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ SchedulesPageActions }) => <SchedulesPageActions />, { search: 'schema=reporting' })

    expect(screen.getByRole('link', { name: 'New schedule' }).getAttribute('href')).toBe('/schedules/new?schema=reporting')
  })

  it('offer Unschedule on a schedule\'s page', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ ScheduleActions }) => <ScheduleActions name="reports" scheduleKey="morning" />)

    expect(screen.getByRole('button', { name: 'Unschedule' })).toBeTruthy()
  })

  it('are left out in read-only mode', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ SchedulesPageActions, ScheduleActions }) => (
      <>
        <SchedulesPageActions />
        <ScheduleActions name="reports" scheduleKey={null} />
      </>
    ), { readOnly: true })

    expect(screen.getByTestId('header')).toBeEmptyDOMElement()
  })

  it('give way to the overlay\'s', async () => {
    mockOverlay({ nav: [], slots: { pageActions: DemoPageActions, scheduleActions: DemoScheduleActions } })
    await renderWith(({ SchedulesPageActions, ScheduleActions }) => (
      <>
        <SchedulesPageActions />
        <ScheduleActions name="reports" scheduleKey="morning" />
      </>
    ))

    expect(screen.getByTestId('pro-page-actions').textContent).toBe('schedules')
    expect(screen.getByTestId('pro-schedule-actions').textContent).toBe('reports:morning')
    expect(screen.queryByRole('link', { name: 'New schedule' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unschedule' })).toBeNull()
  })
})
