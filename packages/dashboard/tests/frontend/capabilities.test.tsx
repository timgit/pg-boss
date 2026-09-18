import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useRouteLoaderData } from 'react-router'
import { CAPABILITIES, can, defaultCapabilities, DEFAULT_DENIAL } from '~/lib/capabilities'
import { useCan, useDenial } from '~/lib/use-capabilities'
import { ReadOnlyNotice } from '~/components/read-only-notice'

// `useRouteLoaderData` is mocked globally in tests/setup.ts so components that read
// the root loader can render without a data router. Steer that mock per case.
function withRootData (data: unknown) {
  vi.mocked(useRouteLoaderData).mockReturnValue(data)
}

function Probe ({ capability }: { capability: Parameters<typeof useCan>[0] }) {
  return <span data-testid="probe">{String(useCan(capability))}</span>
}

describe('capabilities', () => {
  it('permits everything when the dashboard is writable', () => {
    const capabilities = defaultCapabilities(false)

    for (const capability of CAPABILITIES) {
      expect(can(capabilities, capability)).toBe(true)
    }
  })

  it('permits nothing in read-only mode', () => {
    const capabilities = defaultCapabilities(true)

    for (const capability of CAPABILITIES) {
      expect(can(capabilities, capability)).toBe(false)
    }
  })

  /**
   * The rule that decides what an overlay built against an older dashboard does
   * when a newer one adds a control: it stays hidden. The alternative is showing
   * a viewer a button nobody has said they may press.
   */
  it('denies a capability the map does not mention', () => {
    expect(can({}, 'job:delete')).toBe(false)
    expect(can(undefined, 'job:delete')).toBe(false)
  })

  it('denies anything that is not exactly true, rather than coercing it', () => {
    expect(can({ 'job:delete': undefined }, 'job:delete')).toBe(false)
    expect(can({ 'job:delete': 'yes' } as never, 'job:delete')).toBe(false)
  })

  it('covers every capability in the default map, so a new one cannot be forgotten', () => {
    expect(Object.keys(defaultCapabilities(false)).sort()).toEqual([...CAPABILITIES].sort())
  })
})

describe('useCan', () => {
  afterEach(() => {
    vi.mocked(useRouteLoaderData).mockReset()
  })

  it('reads the capability the root loader published', () => {
    withRootData({ can: { 'job:retry': true, 'job:delete': false } })

    render(<Probe capability="job:retry" />)
    expect(screen.getByTestId('probe')).toHaveTextContent('true')
  })

  /** The operator case, and the whole reason this is a map and not a boolean. */
  it('separates one verb from another', () => {
    withRootData({ can: { 'job:retry': true, 'job:delete': false } })

    render(<Probe capability="job:delete" />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })

  it('denies when the field is absent or the loader data is unavailable', () => {
    withRootData({})
    const { unmount } = render(<Probe capability="job:retry" />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
    unmount()

    withRootData(undefined)
    render(<Probe capability="job:retry" />)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })
})

describe('useDenial and ReadOnlyNotice', () => {
  afterEach(() => {
    vi.mocked(useRouteLoaderData).mockReset()
  })

  it('names the variable that has to be unset, with no overlay', () => {
    withRootData({ denial: DEFAULT_DENIAL })
    render(<ReadOnlyNotice action="Sending jobs" />)

    expect(screen.getByText('This dashboard is read-only')).toBeInTheDocument()
    expect(screen.getByText(/PGBOSS_DASHBOARD_READ_ONLY=1/)).toBeInTheDocument()
    expect(screen.getByText(/Sending jobs is disabled/)).toBeInTheDocument()
  })

  it('falls back to that wording when the loader says nothing', () => {
    withRootData(undefined)
    render(<ReadOnlyNotice action="Sending jobs" />)

    expect(screen.getByText('This dashboard is read-only')).toBeInTheDocument()
  })

  /**
   * An overlay's reason replaces it entirely. Telling someone whose role is
   * `viewer` to unset an environment variable points them at a setting that is
   * not the cause and an operator they may not have.
   */
  it('uses the overlay wording when one supplies it', () => {
    withRootData({
      denial: { title: 'Not permitted', detail: 'Your role does not include sending jobs.' },
    })
    render(<ReadOnlyNotice action="Sending jobs" />)

    expect(screen.getByText('Not permitted')).toBeInTheDocument()
    expect(screen.getByText(/Your role does not include sending jobs/)).toBeInTheDocument()
    expect(screen.queryByText(/PGBOSS_DASHBOARD_READ_ONLY/)).not.toBeInTheDocument()
  })
})
