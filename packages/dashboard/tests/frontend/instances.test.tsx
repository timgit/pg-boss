import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { formatSpan, listInstances, matchesInstance } from '~/lib/instances'
import { InstancesTable } from '~/components/instances-table'
import type { Instance } from '~/lib/types'
import { NOW, instance, quiet, secondsAgo, stopped, worker } from '../fixtures/instances'

// The free list, whatever the build: a Pro build mounts its overlay at `~pro`, and the overlay's
// part in the list is tested in pro-overlay.test.tsx against the fixture.
vi.mock('~pro', () => ({ default: { nav: [], slots: {} } }))

const byId = (listed: ReturnType<typeof listInstances>, i: Instance) => listed.find((l) => l.instance.id === i.id)!

describe('listInstances', () => {
  it('lists live and recently quiet instances by default, and older ones with the stopped', () => {
    const live = instance()
    const recent = quiet(120, { name: 'billing', host: 'jobs-03' })
    const old = quiet(2 * 3600, { name: 'reports', host: 'jobs-04' })
    const gone = stopped(600, { name: 'mailer' })

    const listed = listInstances([live, recent, old, gone], NOW)

    expect(listed.map((l) => [l.status, l.bucket])).toEqual([
      ['live', 'live'],
      ['quiet', 'quiet'],
      ['quiet', 'stopped'],
      ['stopped', 'stopped'],
    ])
  })

  it('folds earlier quiet lives under the newest start with the same name and host', () => {
    const first = quiet(1800, { name: 'billing', host: 'jobs-03', startedOn: secondsAgo(2400) })
    const second = quiet(900, { name: 'billing', host: 'jobs-03', startedOn: secondsAgo(1500) })
    const current = instance({ name: 'billing', host: 'jobs-03', startedOn: secondsAgo(300) })
    const elsewhere = instance({ name: 'billing', host: 'jobs-04', startedOn: secondsAgo(60) })

    const listed = listInstances([first, second, current, elsewhere], NOW)

    expect(byId(listed, first)).toMatchObject({ replaced: true, bucket: 'stopped', foldedUnder: current.id })
    expect(byId(listed, second)).toMatchObject({ replaced: true, bucket: 'stopped', foldedUnder: current.id })
    expect(byId(listed, current).earlier.map((i) => i.id)).toEqual([second.id, first.id])
    expect(byId(listed, elsewhere)).toMatchObject({ replaced: false, earlier: [] })
  })

  it('never folds a stopped life, only a crashed one', () => {
    const before = stopped(3600, { name: 'api' })
    const now = instance({ name: 'api', startedOn: secondsAgo(60) })

    const listed = listInstances([before, now], NOW)

    expect(byId(listed, before)).toMatchObject({ foldedUnder: null, bucket: 'stopped' })
    expect(byId(listed, now).earlier).toEqual([])
  })
})

describe('formatSpan', () => {
  it('uses the largest unit that reads well', () => {
    expect([40, 720, 3 * 3600 + 300, 12 * 3600 + 60, 3 * 86400].map((s) => formatSpan(s * 1000)))
      .toEqual(['40s', '12m', '3h 5m', '12h', '3d'])
  })
})

describe('matchesInstance', () => {
  it('matches a name, a host, an id or a queue the instance works', () => {
    const i = instance({ name: 'email-worker', host: 'jobs-01', workers: [worker('email-notifications')] })

    expect(['email', 'JOBS-01', i.id.slice(0, 6), 'notifications', ''].map((n) => matchesInstance(i, n))).toEqual([true, true, true, true, true])
    expect(matchesInstance(i, 'billing')).toBe(false)
  })
})

describe('InstancesTable', () => {
  function renderTable (instances: Instance[]) {
    return render(
      <MemoryRouter>
        <InstancesTable instances={instances} checkedOn={NOW} />
      </MemoryRouter>
    )
  }

  const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)

  it('shows live and quiet instances by name, with a count per status', () => {
    renderTable([
      instance({ name: 'worker', id: 'bbbbbbbb-0000-4000-8000-000000000000' }),
      instance({ name: 'api', id: 'aaaaaaaa-0000-4000-8000-000000000000', supervise: true, schedule: true }),
      quiet(120, { name: 'billing', host: 'jobs-03', id: 'cccccccc-0000-4000-8000-000000000000' }),
      stopped(600, { name: 'mailer', id: 'dddddddd-0000-4000-8000-000000000000' }),
    ])

    expect(names()).toEqual(['apiaaaaaaaa', 'billingcccccccc', 'workerbbbbbbbb'])
    expect(screen.getByRole('button', { name: 'Live 2' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Quiet 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Stopped 1' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('supervisor')).toBeInTheDocument()
    expect(screen.getByText('scheduler')).toBeInTheDocument()
    expect(screen.getByText('By name')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stopped 1' }))
    expect(names()).toContain('mailerdddddddd')
    expect(screen.getByText('stopped 10m ago')).toBeInTheDocument()
  })

  it('says what an instance works, linking each queue', () => {
    renderTable([
      instance({ name: 'jobs', workers: [worker('a'), worker('b'), worker('c')] }),
      instance({ name: 'sender' }),
    ])

    expect(screen.getByRole('link', { name: 'a' })).toHaveAttribute('href', '/queues/a')
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('sends only')).toBeInTheDocument()
  })

  it('folds a crash loop under its newest life, and says how often it restarted', () => {
    const since = secondsAgo(2400)
    renderTable([
      quiet(1800, { name: 'billing', host: 'jobs-03', startedOn: secondsAgo(2400), id: '11111111-0000-4000-8000-000000000000' }),
      quiet(900, { name: 'billing', host: 'jobs-03', startedOn: secondsAgo(1500), id: '22222222-0000-4000-8000-000000000000' }),
      instance({ name: 'billing', host: 'jobs-03', startedOn: secondsAgo(300), crashRestarts: 2, crashRestartsSince: since, id: '33333333-0000-4000-8000-000000000000' }),
    ])

    expect(names()).toEqual(['billing33333333'])
    expect(screen.getByText(/^2 crash restarts since/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 earlier quiet' }))
    expect(names()).toEqual(['billing33333333', 'billing22222222', 'billing11111111'])
    expect(screen.getAllByText('replaced by a newer start')).toHaveLength(2)
  })

  it('filters by name, host or queue', () => {
    renderTable([
      instance({ name: 'api' }),
      instance({ name: 'jobs', workers: [worker('payments')] }),
    ])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter instances' }), { target: { value: 'pay' } })
    expect(names()).toEqual([expect.stringMatching(/^jobs/)])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter instances' }), { target: { value: 'nothing' } })
    expect(screen.getByText('No instances match. Clear the filter or turn on another status.')).toBeInTheDocument()
  })

  it('offers no detail and no extra columns without an overlay', () => {
    renderTable([instance()])

    expect(screen.queryByRole('button', { expanded: false })).toBeNull()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
      ['Instance', 'Host', 'Version', 'Roles', 'Works', 'Up for', 'Heartbeat', 'Status']
    )
  })

  it('says when nothing has registered', () => {
    renderTable([])

    expect(screen.getByText('No instance has registered in this database yet.')).toBeInTheDocument()
  })
})
