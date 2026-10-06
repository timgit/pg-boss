import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { formatSpan, listInstances, matchesInstance, workByQueue, workSettings } from '~/lib/instances'
import { InstancesTable } from '~/components/instances-table'
import { InstancePage } from '~/components/instance-page'
import type { Instance } from '~/lib/types'
import { NOW, instance, quiet, secondsAgo, stopped, worker } from '../fixtures/instances'

// The free list and page, whatever the build: a Pro build mounts its overlay at `~pro`.
vi.mock('~pro', () => ({ default: { nav: [], slots: {} } }))

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

  it('keeps every start as its own row, whatever its name and host', () => {
    const first = quiet(900, { name: 'billing', host: 'jobs-03', startedOn: secondsAgo(1500) })
    const current = instance({ name: 'billing', host: 'jobs-03', startedOn: secondsAgo(300) })

    expect(listInstances([first, current], NOW).map((l) => [l.instance.id, l.bucket])).toEqual([
      [first.id, 'quiet'],
      [current.id, 'live'],
    ])
  })

  it('marks as recent a row started, stopped or gone quiet in the last day', () => {
    const old = instance({ startedOn: secondsAgo(3 * 86400) })
    const fresh = instance({ startedOn: secondsAgo(600) })
    const stoppedToday = stopped(3600)
    const stoppedLastWeek = stopped(3 * 86400)

    expect(listInstances([old, fresh, stoppedToday, stoppedLastWeek], NOW).map((l) => l.recent)).toEqual([false, true, true, false])
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

describe('workByQueue and workSettings', () => {
  it('adds up the calls on each queue, in name order, taking the latest times', () => {
    const a = { ...worker('emails'), id: 'w1', localConcurrency: 2, active: 1, lastFetchedOn: '2026-09-29T11:59:00.000Z' }
    const b = { ...worker('emails'), id: 'w2', localConcurrency: 3, active: 2, lastFetchedOn: '2026-09-29T11:59:30.000Z' }
    const c = worker('billing')

    const groups = workByQueue([a, b, c])

    expect(groups.map((g) => [g.queue, g.workers, g.active, g.calls.length])).toEqual([['billing', 2, 0, 1], ['emails', 5, 3, 2]])
    expect(groups[1].lastFetchedOn).toBe('2026-09-29T11:59:30.000Z')
  })

  it('lists batch size and polling, then only the options a call set', () => {
    expect(workSettings({ ...worker('a'), options: { transactional: true, heartbeatRefreshSeconds: 15 } })).toEqual([
      ['batchSize', '1'],
      ['pollingIntervalSeconds', '2s'],
      ['heartbeatRefreshSeconds', '15s'],
      ['transactional', 'on'],
    ])
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

  const names = () => screen.getAllByRole('row').slice(1).map((r) => within(within(r).getAllByRole('cell')[0]).getAllByRole('link')[0].textContent)

  it('shows live and quiet rows by name, with a count per status', () => {
    renderTable([
      instance({ name: 'worker' }),
      instance({ name: 'api', supervise: true, schedule: true }),
      quiet(120, { name: 'billing', host: 'jobs-03' }),
      stopped(600, { name: 'mailer' }),
    ])

    expect(names()).toEqual(['api', 'billing', 'worker'])
    expect(screen.getByRole('button', { name: 'Live 2' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Quiet 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Stopped 1' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('supervisor')).toBeInTheDocument()
    expect(screen.getByText('scheduler')).toBeInTheDocument()
    expect(screen.getByText('last beat 2m ago')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stopped 1' }))
    expect(names()).toContain('mailer')
    expect(screen.getByText('stopped 10m ago')).toBeInTheDocument()
  })

  it('lists each start on its own, linking to its page', () => {
    const first = quiet(900, { name: 'billing', host: 'jobs-03', startedOn: secondsAgo(1500) })
    const current = instance({ name: 'billing', host: 'jobs-03', startedOn: secondsAgo(300) })
    renderTable([first, current])

    const links = screen.getAllByRole('link', { name: 'billing' })
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/instances/${current.id}`, `/instances/${first.id}`])
    expect(screen.getByText(current.id.slice(0, 8))).toBeInTheDocument()
  })

  it('narrows to the recent rows', () => {
    renderTable([
      instance({ name: 'steady', startedOn: secondsAgo(3 * 86400) }),
      instance({ name: 'fresh', startedOn: secondsAgo(600) }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Recent 1' }))
    expect(names()).toEqual(['fresh'])
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

  it('filters by name, host or queue', () => {
    renderTable([
      instance({ name: 'api' }),
      instance({ name: 'jobs', workers: [worker('payments')] }),
    ])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter instances' }), { target: { value: 'pay' } })
    expect(names()).toEqual(['jobs'])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter instances' }), { target: { value: 'nothing' } })
    expect(screen.getByText('No instances match. Clear the filter or turn on another status.')).toBeInTheDocument()
  })

  it('has no health, grouping or resource columns of its own', () => {
    renderTable([instance()])

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Instance', 'Status', 'Version', 'Roles', 'Works'])
  })

  it('says when nothing has registered', () => {
    renderTable([])

    expect(screen.getByText('No instance has registered in this database yet.')).toBeInTheDocument()
  })
})

describe('InstancePage', () => {
  function renderPage (i: Instance) {
    return render(
      <MemoryRouter>
        <InstancePage data={{ instance: i, instances: [i], checkedOn: NOW }} />
      </MemoryRouter>
    )
  }

  it('names the row by its short id and says how it stands', () => {
    const i = instance({ name: 'billing', host: 'jobs-03', supervise: true })
    renderPage(i)

    expect(screen.getByText(i.id.slice(0, 8))).toHaveAttribute('title', i.id)
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText('supervisor')).toBeInTheDocument()
    expect(screen.getByText(/heartbeat 10s ago, every 30s/)).toBeInTheDocument()
  })

  it('opens a queue to each work() call and the options it set, with the queue page a link away', () => {
    const one = { ...worker('emails'), id: 'aaaaaaaa-1', localConcurrency: 5, options: { transactional: true } }
    const two = { ...worker('billing'), id: 'bbbbbbbb-2' }
    renderPage(instance({ workers: [one, two] }))

    expect(screen.getByText('2 workers on 2 queues · 0 of 7 slots busy')).toBeInTheDocument()
    const emails = screen.getByRole('button', { name: 'emails' })
    expect(emails).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('transactional: on')).not.toBeVisible()

    fireEvent.click(emails)
    expect(emails).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('transactional: on')).toBeVisible()
    expect(screen.getByText('5 × 1')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Queue page for emails' })).toHaveAttribute('href', '/queues/emails')
  })

  it('says when an instance only sends', () => {
    renderPage(instance())

    expect(screen.getByText('No work() calls. This instance only sends jobs.')).toBeInTheDocument()
  })

  it('puts the options changed from the default first, with the default beside each', () => {
    renderPage(instance({ config: { supervise: true, monitorIntervalSeconds: 30, persistQueueStats: true } }))

    expect(screen.getByText('2 changed from the default')).toBeInTheDocument()
    const rows = document.querySelectorAll('details dl div')
    expect([...rows].map((r) => r.querySelector('dt')!.textContent)).toEqual(['monitorIntervalSeconds', 'persistQueueStats', 'supervise'])
    expect(rows[0]).toHaveAttribute('data-changed', 'true')
    expect(rows[0]).toHaveTextContent('30· default 60')
    expect(rows[2]).not.toHaveAttribute('data-changed')
  })

  it('folds its options away', () => {
    renderPage(instance({ config: { monitorIntervalSeconds: 60, supervise: true } }))

    expect(screen.getByText('· 2 recorded')).toBeInTheDocument()
    expect(screen.getByText('monitorIntervalSeconds')).not.toBeVisible()
  })
})
