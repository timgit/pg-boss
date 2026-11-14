import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Pinned per case, as in schedule-actions.test.tsx: the suite also runs with a Pro overlay mounted.
function mockOverlay (overlay: unknown) {
  vi.doMock('~pro', () => ({ default: overlay, overlay }))
  vi.resetModules()
}

const NO_OVERLAY = { nav: [], slots: {} }

function DemoPageActions ({ page }: { page: string }) {
  return <span data-testid="pro-page-actions">{page}</span>
}

function DemoSubscriptionActions ({ subscription }: { subscription: { event: string } }) {
  return <span data-testid="pro-subscription-actions">{subscription.event}</span>
}

function DemoRowActions ({ subscription }: { subscription: { event: string, queue: string } }) {
  return <span data-testid="pro-row-actions">{subscription.event}:{subscription.queue}</span>
}

// tests/setup.ts replaces useRouteLoaderData and useSearchParams with mocks. Each case says what the
// root loader and the URL hold, on the module graph the component is imported from.
async function renderWith (element: (components: typeof import('~/components/subscription-actions')) => React.ReactElement, { readOnly = false, search = '' } = {}) {
  const router = await import('react-router')
  vi.mocked(router.useRouteLoaderData).mockReturnValue({ readOnly })
  vi.mocked(router.useSearchParams).mockReturnValue([new URLSearchParams(search), vi.fn()])

  const components = await import('~/components/subscription-actions')
  const routes = [{ path: '/', element: <div data-testid="header">{element(components)}</div> }]
  render(<router.RouterProvider router={router.createMemoryRouter(routes)} />)
}

describe('the subscription controls', () => {
  afterEach(() => {
    vi.doUnmock('~pro')
    vi.resetModules()
  })

  it('open the subscription form from the Subscriptions page, keeping the schema', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ SubscriptionsPageActions }) => <SubscriptionsPageActions />, { search: 'schema=reporting' })

    expect(screen.getByRole('link', { name: 'New subscription' }).getAttribute('href')).toBe('/subscribe?schema=reporting')
  })

  it('open the form on the event from an event\'s page', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ SubscriptionActions }) => <SubscriptionActions event="user.created" />)

    expect(screen.getByRole('link', { name: 'Subscribe queue' }).getAttribute('href')).toBe('/subscribe?event=user.created')
  })

  it('offer Unsubscribe on each queue of an event', async () => {
    mockOverlay(NO_OVERLAY)
    await renderWith(({ SubscriptionRowActions }) => <SubscriptionRowActions event="user.created" queue="emails" />)

    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeTruthy()
  })

  it('are left out in read-only mode, with no actions column', async () => {
    mockOverlay(NO_OVERLAY)
    let withActions: boolean | undefined
    function Probe ({ use }: { use: () => boolean }) {
      withActions = use()
      return null
    }
    await renderWith(({ SubscriptionsPageActions, SubscriptionActions, SubscriptionRowActions, useSubscriptionRowActions }) => (
      <>
        <SubscriptionsPageActions />
        <SubscriptionActions event="user.created" />
        <SubscriptionRowActions event="user.created" queue="emails" />
        <Probe use={useSubscriptionRowActions} />
      </>
    ), { readOnly: true })

    expect(screen.getByTestId('header')).toBeEmptyDOMElement()
    expect(withActions).toBe(false)
  })

  it('give way to the overlay\'s', async () => {
    mockOverlay({ nav: [], slots: { pageActions: DemoPageActions, subscriptionActions: DemoSubscriptionActions, subscriptionRowActions: DemoRowActions } })
    await renderWith(({ SubscriptionsPageActions, SubscriptionActions, SubscriptionRowActions }) => (
      <>
        <SubscriptionsPageActions />
        <SubscriptionActions event="user.created" />
        <SubscriptionRowActions event="user.created" queue="emails" />
      </>
    ), { readOnly: true })

    expect(screen.getByTestId('pro-page-actions').textContent).toBe('subscriptions')
    expect(screen.getByTestId('pro-subscription-actions').textContent).toBe('user.created')
    expect(screen.getByTestId('pro-row-actions').textContent).toBe('user.created:emails')
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull()
  })
})
